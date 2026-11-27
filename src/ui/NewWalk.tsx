// A box just placed: its card walks you through what it needs, one step at a time, by kind (an
// app: its name, then its tech; a store: what it is, Postgres or S3, and a name only if it needs
// one). Each step is saved as you go, so the box on the canvas fills in while you type. Enter:
// next, and done after the last one it needs. Tab: on to the optional ones (a summary). Esc:
// done. Finishing closes the card, so the next box can go down straight away; opened again,
// it's the box's ordinary card.
// See docs/prototypes/node-card.html, "adding, by kind".
import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";

/** The card floats in after it mounts: focus once it's there. */
function useFocus() {
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => {
    // What's there already (a store's name starts as what it is) is selected: typing replaces it.
    const t = setTimeout(() => {
      ref.current?.focus();
      ref.current?.select();
    }, 40);
    return () => clearTimeout(t);
  }, []);
  return ref;
}
import { backend } from "../backend";
import { useTypeSuggest } from "./TypeSuggest";
import type { Ecosystem, ModelObject, ObjectKind } from "../../shared/model.ts";
import { OUTSIDE_TOOLS, parsePackage, parseSignature } from "../../shared/nodecard.ts";
import { FieldGrid } from "./NodeCard";
import type { ModelIndex } from "../../shared/project.ts";
import { designTechs, techsOf } from "../../shared/references.ts";

type Key = "name" | "tech" | "path" | "pkg" | "summary" | "sig" | "cols";
interface Step {
  key: Key;
  ask: string;
  optional?: boolean;
}

const SUMMARY = (what: string): Step => ({
  key: "summary",
  ask: `One line: ${what}`,
  optional: true,
});
const STEPS: Partial<Record<ObjectKind, Step[]>> = {
  actor: [{ key: "name", ask: "Who? Store manager, Customer…" }, SUMMARY("what they need")],
  system: [{ key: "name", ask: "Name the system" }, SUMMARY("what it's for")],
  app: [
    { key: "name", ask: "Name it: Orders Service, Mobile App…" },
    { key: "tech", ask: "Tech: Rust, Node.js… (Enter when done)" },
    SUMMARY("what it does"),
  ],
  // A service (kind: store) asks for both at once: see ServiceStep.
  store: [{ key: "name", ask: "Name it" }],
  component: [{ key: "name", ask: "Name the component" }, SUMMARY("what it does")],
  table: [
    { key: "name", ask: "Table name: orders" },
    { key: "cols", ask: "Its columns" },
    SUMMARY("what's in it"),
  ],
  // Its name first: a module can be a part of the design that has no file yet. The path is a Tab away.
  module: [
    { key: "name", ask: "Name it: Checks, http.rs…" },
    { key: "path", ask: "Path: services/orders/src/http.rs", optional: true },
    SUMMARY("what's in it"),
  ],
  function: [{ key: "sig", ask: "create_order(Cart, UserId) -> Order" }, SUMMARY("what it does")],
  library: [{ key: "pkg", ask: "Package: axum, react@18, cargo:sqlx" }],
};
const DEFAULT_STEPS: Step[] = [{ key: "name", ask: "Name it" }, SUMMARY("what it is")];

/** Its name is still the one it was made with. */
const unnamed = (o: ModelObject) =>
  /^New [a-z]+$/.test(o.name) || o.name === "new_table" || o.name === "new_function()";
const ECO = (name: string): Ecosystem =>
  /^@|^react|^next|^express|^vite/.test(name) ? "npm" : "cargo";

export function NewWalk({
  o,
  idx,
  save,
  done,
}: {
  o: ModelObject;
  idx: ModelIndex;
  save: (patch: Partial<ModelObject>, label: string) => void;
  done: () => void;
}) {
  const steps = STEPS[o.kind] ?? DEFAULT_STEPS;
  const [at, setAt] = useState(0);
  const step = steps[at];
  // Enter only walks the steps it needs; the optional ones are a Tab away (from any step).
  const next = () =>
    at + 1 >= steps.length || (steps[at + 1]!.optional && !step?.optional) ? done() : setAt(at + 1);
  const lastNeeded = at + 1 >= steps.length || (!!steps[at + 1]!.optional && !steps[at]?.optional);
  const later = steps.filter((s, n) => n > at && s.optional);
  const toOptional = () => {
    const i = steps.findIndex((s, n) => n > at && s.optional);
    return i < 0 ? done() : setAt(i);
  };
  const shown = (s: Step): string => {
    if (s.key === "name") return unnamed(o) ? "" : o.name;
    if (s.key === "tech") return o.technology ?? "";
    if (s.key === "path") return o.path ?? "";
    if (s.key === "sig")
      return unnamed(o) ? "" : `${o.name.replace(/\(\)$/, "")}${o.signature ?? ""}`;
    if (s.key === "cols") return (o.columns ?? []).map((c) => c.name).join(", ");
    if (s.key === "pkg")
      return o.package
        ? `${o.package.ecosystem}:${o.package.name}${o.package.version ? `@${o.package.version}` : ""}`
        : "";
    return o.description ?? "";
  };
  if (!step) return null;
  if (o.kind === "store") return <ServiceStep o={o} idx={idx} save={save} done={done} />;
  return (
    <div className="nw">
      {steps.slice(0, at).map((s, i) => {
        const v = shown(s);
        return v ? (
          <button key={i} className="nw-done" onClick={() => setAt(i)} data-tip="Change it">
            {v}
          </button>
        ) : null;
      })}
      <div className={`nw-ask${step.optional ? " opt" : ""}`}>
        {step.optional ? "Optional" : at === 0 ? "First" : "Then"}
      </div>
      {step.key === "tech" ? (
        <TechStep
          key={at}
          o={o}
          idx={idx}
          ask={step.ask}
          save={save}
          next={next}
          done={done}
          skip={toOptional}
        />
      ) : step.key === "cols" ? (
        <FieldGrid
          key={at}
          head={["column", "type"]}
          rows={(o.columns?.length ? o.columns : [{ name: "id", type: "uuid" }]).map((c) => [
            c.name,
            c.type,
          ])}
          canEdit
          keepFirst
          onDone={next}
          onSave={(rows) => {
            const cols = rows.map(([name, type]) => ({
              name,
              type: type.trim().replace(/\?$/, "") || "text",
              ...(type.trim().endsWith("?") ? { nullable: true } : {}),
            }));
            if (JSON.stringify(cols) !== JSON.stringify(o.columns ?? []))
              save({ columns: cols }, "set columns");
          }}
        />
      ) : (
        <TextStep
          key={at}
          o={o}
          idx={idx}
          step={step}
          start={shown(step)}
          save={save}
          next={next}
          done={done}
          skip={toOptional}
        />
      )}
      {step.key !== "cols" && (
        <div className="nw-keys">
          <span>
            <kbd>Enter</kbd> {lastNeeded ? "done" : "next"}
          </span>
          {later.length > 0 && (
            <span>
              <kbd>Tab</kbd>{" "}
              {later
                .map((s) =>
                  s.key === "summary" ? "a summary" : s.key === "name" ? "a name" : s.key,
                )
                .join(", then ")}
            </span>
          )}
        </div>
      )}
    </div>
  );
}

interface StepProps {
  o: ModelObject;
  save: (patch: Partial<ModelObject>, label: string) => void;
  next: () => void;
  done: () => void;
  skip: () => void;
}

function TextStep({
  o,
  idx,
  step,
  start,
  save,
  next,
  done,
  skip,
}: StepProps & { idx: ModelIndex; step: Step; start: string }) {
  const [v, setV] = useState(start);
  const [err, setErr] = useState("");
  const ref = useFocus();
  // A function's signature: the design's entities as you type a type.
  const ts = useTypeSuggest(idx, v, setV, ref);
  const typing = step.key === "sig";
  const keep = (): boolean => {
    const t = v.trim();
    if (t === start.trim()) return true;
    if (step.key === "name") {
      if (t) save({ name: t }, "name it");
    } else if (step.key === "summary") save({ description: t || undefined }, "describe it");
    else if (step.key === "path") {
      if (!t) return true;
      const last = t.split("/").filter(Boolean).pop() ?? t;
      save({ path: t, ...(unnamed(o) ? { name: last } : {}) }, "set path");
    } else if (step.key === "sig") {
      if (!t) return true;
      const f = parseSignature(t);
      if (!f) return (setErr("A name, maybe with its inputs: create_order(Cart) -> Order"), false);
      save({ name: `${f.name}()`, signature: f.signature }, "name it");
    } else if (step.key === "pkg") {
      if (!t) return true;
      const p = parsePackage(t);
      if (!p) return (setErr("A package name: axum, react@18, cargo:sqlx"), false);
      save(
        {
          name: p.name,
          package: {
            ecosystem: p.ecosystem ?? ECO(p.name),
            name: p.name,
            ...(p.version ? { version: p.version } : {}),
          },
        },
        "set package",
      );
    }
    return true;
  };
  // An app named after an outside tool (Stripe): someone else's service, with its logo. It needs
  // nothing more, so it's done.
  const [pick, setPick] = useState(0);
  // Enter takes a tool only when it's the name typed, or one picked with the arrows: an app
  // called "Post Office" stays one.
  const [arrowed, setArrowed] = useState(false);
  const q = v.trim().toLowerCase();
  const tools =
    step.key === "name" && o.kind === "app" && q
      ? Object.keys(OUTSIDE_TOOLS)
          .filter((n) => n.toLowerCase().startsWith(q))
          .slice(0, 5)
      : [];
  const toolAt = Math.min(pick, Math.max(0, tools.length - 1));
  const beTool = (tool: string) => {
    save(
      {
        name: tool,
        technology: tool,
        external: true,
        ...(o.description ? {} : { description: OUTSIDE_TOOLS[tool] }),
      },
      `${tool}, outside`,
    );
    done();
  };
  const keys = (e: KeyboardEvent<HTMLInputElement>) => {
    e.stopPropagation();
    if (typing && ts.onKey(e)) return;
    if (e.key === "ArrowDown" && tools.length)
      return (
        e.preventDefault(),
        setArrowed(true),
        setPick(Math.min(toolAt + 1, tools.length - 1))
      );
    if (e.key === "ArrowUp" && tools.length)
      return (e.preventDefault(), setArrowed(true), setPick(Math.max(toolAt - 1, 0)));
    const exact = tools.find((n) => n.toLowerCase() === q);
    if (e.key === "Enter" && (exact || (arrowed && tools[toolAt])))
      return (e.preventDefault(), beTool(exact ?? tools[toolAt]!));
    if (e.key === "Enter") return (e.preventDefault(), keep() && next());
    if (e.key === "Tab" && !e.shiftKey) return (e.preventDefault(), keep() && skip());
    if (e.key === "Escape") return (e.preventDefault(), keep() && done());
  };
  return (
    <>
      <input
        ref={ref}
        className={`nc-in nw-in${step.key === "path" || step.key === "pkg" || o.kind === "function" || o.kind === "table" ? " mono" : ""}`}
        value={v}
        placeholder={step.ask}
        autoComplete="off"
        spellCheck={false}
        onChange={(e) => (
          setV(e.target.value),
          setErr(""),
          setPick(0),
          setArrowed(false),
          ts.changed()
        )}
        onSelect={ts.track}
        onKeyDown={keys}
        onBlur={() => keep()}
      />
      {typing && ts.list}
      {tools.length > 0 && (
        <div className="nc-sugg">
          {tools.map((n, i) => (
            <button
              key={n}
              className={arrowed && i === toolAt ? "on" : ""}
              onMouseDown={(e) => (e.preventDefault(), beTool(n))}
              onMouseEnter={() => setPick(i)}
            >
              <span className="nc-sugg-v">{n}</span>
              <span className="nc-sugg-m">outside · {OUTSIDE_TOOLS[n]}</span>
            </button>
          ))}
        </div>
      )}
      {err && <div className="nw-err">{err}</div>}
    </>
  );
}

/** The last of a comma-separated list, as it's being typed. */
const lastWord = (s: string) => s.slice(s.lastIndexOf(",") + 1).trim();

/**
 * A service just placed (a database, a queue, a bucket, a cluster: anything ready-made): its
 * name and what it runs on, side by side, either one enough. Enter anywhere saves both and
 * closes, so the next one can go down. Asked one after the other, the tech became the name
 * and the name was never asked.
 */
function ServiceStep({
  o,
  idx,
  save,
  done,
}: Pick<StepProps, "o" | "save" | "done"> & { idx: ModelIndex }) {
  const [name, setName] = useState(unnamed(o) ? "" : o.name);
  const [tech, setTech] = useState(o.technology ?? "");
  const [more, setMore] = useState<{ q: string; list: string[] }>({ q: "", list: [] });
  // The tech as it stood when a suggestion was taken: nothing more is offered until it changes.
  const [taken, setTaken] = useState("");
  const [pick, setPick] = useState(0);
  const ref = useFocus();
  const q = lastWord(tech);
  const mine = useMemo(() => designTechs(idx).map((t) => t.name), [idx]);
  // Every technology there's a logo for, looked up as it's typed.
  useEffect(() => {
    if (!q) return;
    let live = true;
    void backend.icons
      .search(q)
      .then((list) => live && setMore({ q, list }))
      .catch(() => {});
    return () => void (live = false);
  }, [q]);
  // What the design already runs on first.
  const here = q ? mine.filter((t) => t.toLowerCase().startsWith(q.toLowerCase())) : [];
  const found =
    !q || tech === taken
      ? []
      : [...new Set([...here, ...(more.q === q ? more.list : [])])].slice(0, 6);
  const at = Math.min(pick, Math.max(0, found.length - 1));
  const take = (t: string) => {
    const head = tech.slice(0, tech.lastIndexOf(",") + 1);
    const next = `${head}${head ? " " : ""}${t}`;
    setTech(next);
    setTaken(next);
    setPick(0);
  };
  const finish = (techNow = tech) => {
    const techs = techsOf(techNow);
    const n = name.trim() || techs[0] || "";
    const patch: Partial<ModelObject> = {};
    if (n && n !== o.name) patch.name = n;
    if (techs.join(", ") !== (o.technology ?? "")) patch.technology = techs.join(", ") || undefined;
    if (Object.keys(patch).length) save(patch, n ? `name it ${n}` : "set tech");
    done();
  };
  const keys = (e: KeyboardEvent<HTMLInputElement>, onTech: boolean) => {
    e.stopPropagation();
    if (onTech && found.length && e.key === "ArrowDown")
      return (e.preventDefault(), setPick(Math.min(at + 1, found.length - 1)));
    if (onTech && found.length && e.key === "ArrowUp")
      return (e.preventDefault(), setPick(Math.max(at - 1, 0)));
    if (e.key === "Enter") {
      e.preventDefault();
      // What's typed grows into what it means (pubs → Google Pub/Sub): the suggestion that is
      // exactly it, or else the one that's lit.
      const sug = found.find((f) => f.toLowerCase() === q.toLowerCase()) ?? found[at] ?? "";
      const head = tech.slice(0, tech.lastIndexOf(",") + 1);
      return finish(sug ? `${head}${head ? " " : ""}${sug}` : tech);
    }
    if (e.key === "Escape") return (e.preventDefault(), finish());
  };
  return (
    <div className="nw">
      <div className="nw-ask">Name</div>
      <input
        ref={ref}
        className="nc-in nw-in"
        value={name}
        placeholder="Orders DB, Events bus… (or leave it: named by what it is)"
        autoComplete="off"
        spellCheck={false}
        onChange={(e) => setName(e.target.value)}
        onKeyDown={(e) => keys(e, false)}
      />
      <div className="nw-ask">Runs on</div>
      <input
        className="nc-in nw-in"
        value={tech}
        placeholder="Postgres, Pub/Sub, Kubernetes, S3… (commas for several)"
        autoComplete="off"
        spellCheck={false}
        onChange={(e) => (setTech(e.target.value), setPick(0))}
        onKeyDown={(e) => keys(e, true)}
      />
      {found.length > 0 && (
        <div className="nc-sugg">
          {found.map((s, i) => (
            <button
              key={s}
              className={i === at ? "on" : ""}
              onMouseDown={(e) => (e.preventDefault(), take(s))}
              onMouseEnter={() => setPick(i)}
            >
              <span className="nc-sugg-v">{s}</span>
            </button>
          ))}
        </div>
      )}
      <div className="nw-keys">
        <span>
          <kbd>Enter</kbd> done
        </span>
        <span>
          <kbd>Tab</kbd> the other one
        </span>
      </div>
    </div>
  );
}

function TechStep({
  o,
  idx,
  ask,
  save,
  next,
  done,
  skip,
}: StepProps & { idx: ModelIndex; ask: string }) {
  const [q, setQ] = useState("");
  const [pick, setPick] = useState(0);
  const have = techsOf(o.technology);
  const all = useMemo(() => designTechs(idx), [idx]);
  const t = q.trim().toLowerCase();
  const list = t
    ? all
        .filter(
          (x) =>
            x.name.toLowerCase().startsWith(t) &&
            !have.some((h) => h.toLowerCase() === x.name.toLowerCase()),
        )
        .slice(0, 5)
    : [];
  const at = Math.min(pick, Math.max(0, list.length - 1));
  const ref = useFocus();
  const add = (name: string) => {
    if (!name || have.some((h) => h.toLowerCase() === name.toLowerCase())) return;
    const patch: Partial<ModelObject> = { technology: [...have, name].join(", ") };
    save(patch, `add ${name}`);
    setQ("");
    setPick(0);
  };
  const keys = (e: KeyboardEvent<HTMLInputElement>) => {
    e.stopPropagation();
    if (e.key === "ArrowDown" && list.length)
      return (e.preventDefault(), setPick(Math.min(at + 1, list.length - 1)));
    if (e.key === "ArrowUp" && list.length)
      return (e.preventDefault(), setPick(Math.max(at - 1, 0)));
    if (e.key === "Enter") {
      e.preventDefault();
      if (!q.trim()) return next();
      add(list[at]?.name ?? q.trim());
      return;
    }
    if (e.key === "Tab" && !e.shiftKey) {
      e.preventDefault();
      if (list[at]) return setQ(list[at]!.name);
      if (q.trim()) add(q.trim());
      return skip();
    }
    if (e.key === "Backspace" && !q && have.length)
      return save(
        { technology: have.slice(0, -1).join(", ") || undefined },
        `remove ${have[have.length - 1]}`,
      );
    if (e.key === "Escape") return (e.preventDefault(), q.trim() && add(q.trim()), done());
  };
  return (
    <>
      {have.length > 0 && (
        <div className="nw-chips">
          {have.map((h) => (
            <span key={h} className="nc-chip static">
              {h}
            </span>
          ))}
        </div>
      )}
      <input
        ref={ref}
        className="nc-in nw-in"
        value={q}
        placeholder={have.length ? "Another, or Enter when done" : ask}
        autoComplete="off"
        spellCheck={false}
        onChange={(e) => (setQ(e.target.value), setPick(0))}
        onKeyDown={keys}
      />
      {list.length > 0 && (
        <div className="nc-sugg">
          {list.map((s, i) => (
            <button
              key={s.name}
              className={i === at ? "on" : ""}
              onMouseDown={(e) => (e.preventDefault(), add(s.name))}
              onMouseEnter={() => setPick(i)}
            >
              <span className="nc-sugg-v">{s.name}</span>
              <span className="nc-sugg-m">{s.count} use it</span>
            </button>
          ))}
        </div>
      )}
    </>
  );
}
