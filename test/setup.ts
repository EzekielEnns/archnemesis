// Run from a git hook (pre-push), git hands its own repository to every child through GIT_DIR
// and friends. Tests that make throwaway repos would then act on this one instead: drop them.
for (const k of Object.keys(process.env))
  if (/^GIT_(DIR|WORK_TREE|INDEX_FILE|PREFIX|COMMON_DIR|OBJECT_DIRECTORY|NAMESPACE)$/.test(k))
    delete process.env[k];
