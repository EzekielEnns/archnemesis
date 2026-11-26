// show: drive what the person sees. Open a view or a box, spotlight several, walk them through
// a tour (the call holds while they read and press Next), or render a view as a picture.
// It changes nothing in the design.
import { findView } from "../agent.ts";
import type { ModelIndex } from "../project.ts";
import { ToolError, fail, ok, type Host, type Out, type Stop } from "./host.ts";
import { ambiguity, idOf, refOf, resolve, viewFor, viewId } from "./refs.ts";

interface TourStep {
  ref?: string;
  refs?: string[];
  view?: string;
  flow?: string;
  step?: number;
  tag?: string;
  say?: string;
  /** Code or docs for this stop (repo@ref:path, URLs). */
  code?: string[];
}

export interface ShowArgs {
  open?: string;
  spotlight?: string[];
  view?: string;
  say?: string;
  tour?: TourStep[];
  /** Which tour step to start at (from 0): to carry on after a question or a pause. */
  at?: number;
  render?: string;
  flow?: string;
  step?: number;
  done?: boolean;
  /** How long the call may hold for a tour, in seconds (default 55). */
  wait_s?: number;
}

const DEFAULT_WAIT = 55;

/** Where a step points: the view, the box or boxes, a flow step. */
function stopFor(idx: ModelIndex, s: TourStep): Stop {
  const refs = [...(s.ref ? [s.ref] : []), ...(s.refs ?? [])];
  let diagram: string | undefined = s.view ? findView(idx, s.view).id : undefined;
  const objects: string[] = [];
  for (const r of refs) {
    const x = resolve(idx, r);
    const id = x.kind === "object" ? x.o.id : x.kind === "entity" ? x.e.sourceId : null;
    if (x.kind === "view") diagram ??= x.d.id;
    else if (x.kind === "connection") objects.push(x.c.fromId, x.c.toId);
    else if (x.kind === "note") diagram ??= x.n.diagramId;
    else if (id) objects.push(id);
  }
  if (!diagram && objects.length) {
    const at = viewFor(idx, objects[0]!);
    if (!at)
      throw new ToolError(
        `${refOf(idx, objects[0]!)} isn't drawn on any view, nor is anything it's inside`,
      );
    diagram = at.d.id;
  }
  if (!diagram) throw new ToolError("say where: a ref, refs or a view");
  // What's drawn here: a box hidden inside another shows as the box it's in.
  const placed = idx.placements.get(diagram);
  const drawn = [
    ...new Set(
      objects
        .map((id) => {
          for (let cur: string | null | undefined = id; cur; cur = idx.objects.get(cur)?.parentId)
            if (placed?.has(cur)) return cur;
          return null;
        })
        .filter((x): x is string => !!x),
    ),
  ];
  const d = idx.diagrams.get(diagram)!;
  const f = s.flow
    ? [...idx.flows.values()].find(
        (x) =>
          x.diagramId === diagram &&
          (x.id === s.flow || x.name.toLowerCase() === s.flow!.trim().toLowerCase()),
      )
    : undefined;
  if (s.flow && !f)
    throw new ToolError(
      `no flow "${s.flow}" on ${viewId(d)}; flows: ${
        [...idx.flows.values()]
          .filter((x) => x.diagramId === diagram)
          .map((x) => x.name)
          .join(", ") || "none"
      }`,
    );
  if (f && s.step && s.step > f.steps.length)
    throw new ToolError(`${f.name} has ${f.steps.length} steps`);
  return {
    diagram,
    object: drawn.length === 1 ? drawn[0]! : null,
    ...(drawn.length > 1 ? { objects: drawn } : {}),
    flow: f?.id ?? null,
    step: f && s.step ? s.step - 1 : -1,
    tag: s.tag ?? null,
    ...(s.code?.length ? { refs: s.code } : {}),
    say: (s.say ?? "").trim(),
  };
}

export async function show(host: Host, a: ShowArgs, signal?: AbortSignal): Promise<Out> {
  const idx = host.index();
  if (a.render) {
    if (!host.render)
      return fail("render needs the Archnemesis server; here the person sees the canvas already");
    const d = findView(idx, a.render);
    const f = a.flow
      ? [...idx.flows.values()].find(
          (x) =>
            x.diagramId === d.id &&
            (x.id === a.flow || x.name.toLowerCase() === a.flow!.toLowerCase()),
        )
      : undefined;
    const { png, url } = await host.render(d.id, {
      flow: f?.id,
      step: a.step ? a.step - 1 : undefined,
    });
    return {
      text: `${d.name}${f ? `, flow ${f.name}` : ""}\nimage: ${url}\nopen: ${host.url(d.id)}`,
      images: [{ data: png, mimeType: "image/png" }],
    };
  }
  const canvas = host.canvas;
  if (!canvas)
    return fail(
      `There's no canvas to drive from here (this connection doesn't belong to a person). Send them a link instead: ${host.url()}`,
    );
  if (a.done) {
    canvas.end();
    return ok("Walkthrough over: their view is theirs again.");
  }
  const nobody =
    canvas.watching?.() === 0 ? " Nobody has this design open right now: send them the link." : "";
  if (a.tour?.length) {
    const steps = a.tour.map((s) => stopFor(idx, s));
    const total = steps.length;
    const deadline = Date.now() + (a.wait_s ?? DEFAULT_WAIT) * 1000;
    let i = Math.max(0, Math.min(a.at ?? 0, total - 1));
    while (i < total) {
      const ms = deadline - Date.now();
      if (ms <= 0)
        return ok(
          `Paused at step ${i + 1} of ${total} (it's still showing).${nobody} Carry on: show {tour (the same steps), at: ${i}}.`,
          { at: i },
        );
      const reply = await canvas.show(
        { ...steps[i]!, say: `${steps[i]!.say}${total > 1 ? ` (${i + 1}/${total})` : ""}` },
        { ms, signal },
      );
      if (signal?.aborted) return ok(`Stopped at step ${i + 1}.`);
      if (!reply)
        return ok(
          `Paused at step ${i + 1} of ${total}: nothing pressed in time (it's still showing).${nobody} Carry on: show {tour, at: ${i}}, or ask them in chat whether they're still there.`,
          { at: i },
        );
      if (reply.action === "stop") {
        canvas.end();
        return ok(`They stopped the tour at step ${i + 1}.`, { at: i, action: "stop" });
      }
      if (reply.action === "ask")
        return ok(
          `At step ${i + 1} they asked: ${reply.text ?? ""}\nAnswer it (show {open, say: your answer}), then carry on: show {tour, at: ${i}}.`,
          { at: i, action: "ask", question: reply.text ?? "" },
        );
      i = reply.action === "back" ? Math.max(0, i - 1) : i + 1;
    }
    canvas.end();
    return ok(`Tour done: all ${total} steps.`, { at: total });
  }
  if (a.open || a.spotlight?.length || a.view) {
    const s = stopFor(idx, {
      ...(a.open ? { ref: a.open } : {}),
      refs: a.spotlight,
      view: a.view,
      flow: a.flow,
      step: a.step,
      say: a.say,
    });
    await canvas.show(s);
    const d = idx.diagrams.get(s.diagram)!;
    const what = s.objects?.length
      ? `${s.objects.length} boxes`
      : s.object
        ? idOf(idx.objects.get(s.object)!)
        : "";
    // A ref that names two things (a box and a view): say which it showed, and the other's ref.
    const both = [...(a.open ? [a.open] : []), ...(a.spotlight ?? [])].flatMap(
      (r) => ambiguity(idx, r, resolve(idx, r)) ?? [],
    );
    return ok(
      `${both.length ? `${both.join(" ")}\n` : ""}Showing ${viewId(d)}${what ? `, ${what}` : ""}.${nobody} ${host.url(d.id, s.object ?? undefined)}`,
    );
  }
  return fail("Say what: open (a ref), spotlight (refs), tour (steps), render (a view) or done.");
}
