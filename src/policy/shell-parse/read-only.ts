// The built-in read-only commands as data (permissions §4.0 item 3, §4.6): accepted options and where file paths sit.
// Not user-configurable; any option not listed makes the command not read-only.

export type Word = {
  text: string;
  /** No expansion the analyzer can't see through (quotes removed, escapes resolved). */
  literal: boolean;
  /** Contains an unquoted glob character. */
  glob: boolean;
  /** A loop variable: the values it takes. */
  values?: string[];
};

export const READ_ONLY_VERSION = 1;

type Spec = {
  /** Short options without a value, one letter each. */
  flags?: string;
  /** Short options with a value / with a path value. */
  valued?: string;
  pathValued?: string;
  /** Long options without a value, with a value, with a path value. */
  long?: string[];
  longValued?: string[];
  longPath?: string[];
  /** What the positional arguments are. `pattern`: the first is a pattern unless `patternOpts` supplied one. */
  args: "paths" | "words" | "pattern" | "none";
  /** Options (letters or long names) that supply the pattern themselves. */
  patternOpts?: string[];
  /** `-5` style count. */
  number?: boolean;
  /** Every argument is plain text, options included (`echo --- x`). */
  raw?: boolean;
  /** An unquoted glob anywhere makes the command not read-only (it may expand into options). */
  strictGlob?: boolean;
};

const LS: Spec = {
  flags: "aAbcCdfFgGhHiklLmnopqrRsStuUvx1",
  valued: "wITH",
  long: [
    "all",
    "almost-all",
    "human-readable",
    "classify",
    "directory",
    "recursive",
    "reverse",
    "size",
    "inode",
    "long",
  ],
  longValued: ["color", "sort", "format", "time", "time-style", "indicator-style", "width", "ignore"],
  args: "paths",
};

const GREP: Spec = {
  flags: "aEFGHhIiLlnoPqrRsTUuVvwxZzc",
  valued: "ABCmdD",
  pathValued: "f",
  long: [
    "recursive",
    "dereference-recursive",
    "ignore-case",
    "invert-match",
    "word-regexp",
    "line-regexp",
    "count",
    "files-with-matches",
    "files-without-match",
    "line-number",
    "no-filename",
    "with-filename",
    "only-matching",
    "quiet",
    "silent",
    "no-messages",
    "extended-regexp",
    "fixed-strings",
    "basic-regexp",
    "perl-regexp",
    "null",
    "text",
  ],
  longValued: [
    "include",
    "exclude",
    "exclude-dir",
    "color",
    "colour",
    "max-count",
    "regexp",
    "after-context",
    "before-context",
    "context",
    "binary-files",
  ],
  longPath: ["file", "exclude-from"],
  args: "pattern",
  patternOpts: ["e", "f", "regexp", "file"],
  strictGlob: false,
};

const RG: Spec = {
  flags: "abcFhHiIlLnNopqsSuUvwxj",
  valued: "ABCmgtTeEMd",
  pathValued: "f",
  long: [
    "files",
    "hidden",
    "no-ignore",
    "count",
    "files-with-matches",
    "files-without-match",
    "line-number",
    "no-line-number",
    "ignore-case",
    "smart-case",
    "case-sensitive",
    "fixed-strings",
    "word-regexp",
    "line-regexp",
    "json",
    "no-heading",
    "heading",
    "only-matching",
    "invert-match",
    "multiline",
    "follow",
    "no-messages",
    "quiet",
    "stats",
    "type-list",
    "with-filename",
    "no-filename",
  ],
  longValued: [
    "color",
    "glob",
    "type",
    "type-not",
    "max-count",
    "max-depth",
    "regexp",
    "after-context",
    "before-context",
    "context",
    "threads",
    "sort",
    "sortr",
  ],
  longPath: ["file", "ignore-file"],
  args: "pattern",
  patternOpts: ["e", "f", "regexp", "file"],
};

const FD: Spec = {
  flags: "HIiaLsgpuhVl",
  valued: "tedEScC",
  long: [
    "hidden",
    "no-ignore",
    "ignore-case",
    "case-sensitive",
    "absolute-path",
    "follow",
    "glob",
    "full-path",
    "list-details",
  ],
  longValued: ["type", "extension", "max-depth", "exclude", "color", "size"],
  args: "pattern",
};

const SPECS: Record<string, Spec> = {
  ls: LS,
  cat: {
    flags: "AbeEnstTuv",
    long: ["number", "number-nonblank", "show-all", "squeeze-blank", "show-ends", "show-tabs", "show-nonprinting"],
    args: "paths",
  },
  echo: { raw: true, args: "words" },
  printf: { raw: true, args: "words" },
  pwd: { flags: "LP", args: "none" },
  head: {
    flags: "qvz",
    valued: "nc",
    long: ["quiet", "verbose"],
    longValued: ["lines", "bytes"],
    number: true,
    args: "paths",
  },
  tail: {
    flags: "qvz",
    valued: "nc",
    long: ["quiet", "verbose"],
    longValued: ["lines", "bytes"],
    number: true,
    args: "paths",
  },
  grep: GREP,
  egrep: GREP,
  fgrep: GREP,
  rg: RG,
  fd: FD,
  fdfind: FD,
  wc: { flags: "clmwL", long: ["bytes", "chars", "lines", "words", "max-line-length"], args: "paths" },
  date: { flags: "u", args: "words" },
  which: { flags: "a", args: "words" },
  diff: {
    flags: "qsuiEZbwBaTNrcyd",
    valued: "UCxIFL",
    long: [
      "brief",
      "unified",
      "recursive",
      "ignore-case",
      "new-file",
      "report-identical-files",
      "ignore-all-space",
      "ignore-space-change",
      "side-by-side",
      "ignore-blank-lines",
    ],
    longValued: ["unified", "context", "exclude", "label", "color"],
    args: "paths",
  },
  cmp: { flags: "lsb", valued: "inN", long: ["silent", "quiet", "verbose", "print-bytes"], args: "paths" },
  comm: { flags: "123z", long: ["check-order", "nocheck-order"], args: "paths" },
  stat: {
    flags: "Lftz",
    valued: "c",
    long: ["dereference", "file-system", "terse"],
    longValued: ["format", "printf"],
    args: "paths",
  },
  du: {
    flags: "ahkmsxcLHbPSTX",
    valued: "dBt",
    long: ["all", "human-readable", "summarize", "total", "bytes", "apparent-size"],
    longValued: ["max-depth", "block-size", "threshold", "exclude"],
    args: "paths",
  },
  df: {
    flags: "ahHiklPTm",
    valued: "tx",
    long: ["all", "human-readable", "inodes", "local", "portability", "print-type"],
    longValued: ["type", "exclude-type", "output"],
    args: "paths",
  },
  file: {
    flags: "bhiLkNnsvz",
    long: ["brief", "mime", "mime-type", "mime-encoding", "dereference", "keep-going"],
    args: "paths",
  },
  tree: {
    flags: "adfiLlpqrstuvxACDFNQ",
    valued: "LIP",
    long: ["dirsfirst", "noreport", "du", "gitignore"],
    args: "paths",
  },
  uname: {
    flags: "asnrvmpio",
    long: [
      "all",
      "kernel-name",
      "nodename",
      "kernel-release",
      "kernel-version",
      "machine",
      "processor",
      "operating-system",
    ],
    args: "none",
  },
  true: { args: "none" },
  false: { args: "none" },
  test: { raw: true, args: "words" },
  expr: { raw: true, args: "words" },
  seq: { flags: "w", valued: "fs", args: "words" },
  fmt: { flags: "cstux", valued: "wpgT", args: "paths" },
  numfmt: {
    longValued: ["to", "from", "suffix", "padding", "format", "round", "field", "delimiter", "header"],
    long: ["invalid"],
    args: "words",
  },
  tsort: { args: "paths" },
  pr: { flags: "dFmrtTa", valued: "eiLnNosSwWlh", args: "paths" },
  getconf: { args: "words" },
  tput: { valued: "T", args: "words" },
  lsof: { flags: "lnPRtVwNUOh", valued: "ipucgdr", args: "words" },
  pgrep: { flags: "flaxvonwi", valued: "uUgGPstTF", args: "words" },
  ss: { flags: "tuwxlanpesrHo4620", args: "none" },
  help: { args: "words" },
  man: { args: "words" },
  // ASSUMPTION (QUESTIONS Q41): AC-PERM-21 needs these two; the awk program is checked separately.
  cut: {
    flags: "snz",
    valued: "dbcf",
    long: ["complement", "only-delimited", "zero-terminated"],
    longValued: ["delimiter", "fields", "characters", "bytes", "output-delimiter"],
    args: "paths",
  },
  awk: { valued: "F", args: "pattern", strictGlob: true },
};

const GIT_COMMON: Spec = { flags: "", long: ["no-color", "color", "no-pager"], args: "paths", strictGlob: true };
const GIT: Record<string, Spec> = {
  status: {
    ...GIT_COMMON,
    flags: "sbvz",
    valued: "u",
    long: ["short", "branch", "porcelain", "ignored", "long", "no-color", "verbose", "ahead-behind", "no-ahead-behind"],
    longValued: ["untracked-files", "ignore-submodules", "porcelain", "column"],
  },
  diff: {
    ...GIT_COMMON,
    flags: "pusabw",
    valued: "UMC",
    long: [
      "stat",
      "numstat",
      "shortstat",
      "name-only",
      "name-status",
      "cached",
      "staged",
      "check",
      "summary",
      "patch",
      "minimal",
      "ignore-all-space",
      "ignore-space-change",
      "no-renames",
      "histogram",
      "patience",
      "raw",
      "color",
      "no-color",
      "no-pager",
    ],
    longValued: ["unified", "stat", "color", "diff-filter", "find-renames", "word-diff", "abbrev", "relative"],
  },
  log: {
    ...GIT_COMMON,
    flags: "p",
    number: true,
    valued: "n",
    long: [
      "oneline",
      "graph",
      "decorate",
      "all",
      "stat",
      "name-only",
      "name-status",
      "merges",
      "no-merges",
      "first-parent",
      "reverse",
      "patch",
      "no-decorate",
      "abbrev-commit",
      "color",
      "no-color",
      "no-pager",
      "follow",
      "shortstat",
      "numstat",
    ],
    longValued: [
      "max-count",
      "since",
      "until",
      "after",
      "before",
      "author",
      "committer",
      "grep",
      "format",
      "pretty",
      "date",
      "skip",
      "abbrev",
      "decorate",
      "diff-filter",
    ],
  },
  show: {
    ...GIT_COMMON,
    flags: "s",
    long: [
      "stat",
      "name-only",
      "name-status",
      "oneline",
      "no-patch",
      "patch",
      "color",
      "no-color",
      "no-pager",
      "shortstat",
      "numstat",
      "abbrev-commit",
    ],
    longValued: ["format", "pretty", "date", "unified", "abbrev", "diff-filter"],
  },
  branch: {
    ...GIT_COMMON,
    flags: "arvl",
    long: ["all", "remotes", "verbose", "list", "show-current", "no-color", "color", "no-pager"],
    longValued: ["contains", "no-contains", "merged", "no-merged", "sort", "format", "points-at", "abbrev"],
    args: "none",
  },
  "rev-parse": {
    ...GIT_COMMON,
    long: [
      "show-toplevel",
      "git-dir",
      "abbrev-ref",
      "is-inside-work-tree",
      "verify",
      "show-prefix",
      "show-cdup",
      "is-bare-repository",
      "git-common-dir",
      "symbolic-full-name",
      "no-pager",
    ],
    longValued: ["short"],
    args: "words",
    strictGlob: false,
  },
  "ls-files": {
    ...GIT_COMMON,
    flags: "cdmoiskzutvf",
    long: [
      "cached",
      "deleted",
      "modified",
      "others",
      "ignored",
      "stage",
      "unmerged",
      "killed",
      "directory",
      "exclude-standard",
      "full-name",
      "error-unmatch",
      "no-pager",
    ],
    longValued: ["exclude"],
  },
  blame: {
    ...GIT_COMMON,
    flags: "lwMCefpnsStb",
    valued: "L",
    long: ["porcelain", "line-porcelain", "show-name", "show-email", "show-stats", "no-pager"],
    longValued: ["since"],
    longPath: ["ignore-revs-file", "ignore-rev"],
  },
};

export type Classified = { ok: true; paths: Word[] } | { ok: false; reason: string };

const FIND_VALUED = new Set([
  "-name",
  "-iname",
  "-path",
  "-ipath",
  "-regex",
  "-iregex",
  "-type",
  "-size",
  "-mtime",
  "-atime",
  "-ctime",
  "-mmin",
  "-amin",
  "-cmin",
  "-newer",
  "-perm",
  "-user",
  "-group",
  "-uid",
  "-gid",
  "-maxdepth",
  "-mindepth",
  "-lname",
  "-ilname",
  "-wholename",
  "-iwholename",
  "-xtype",
  "-links",
  "-samefile",
]);
const FIND_BARE = new Set([
  "-print",
  "-print0",
  "-prune",
  "-empty",
  "-depth",
  "-xdev",
  "-mount",
  "-follow",
  "-ls",
  "-readable",
  "-writable",
  "-executable",
  "-true",
  "-false",
  "-and",
  "-or",
  "-not",
  "-a",
  "-o",
  "!",
  "(",
  ")",
  "-noleaf",
  "-daystart",
]);

function classifyFind(args: Word[]): Classified {
  const paths: Word[] = [];
  let i = 0;
  for (; i < args.length && /^-[HLP]$/.test(args[i]?.text ?? ""); i++);
  for (; i < args.length; i++) {
    const w = args[i] as Word;
    if (w.text.startsWith("-") || w.text === "!" || w.text === "(") break;
    paths.push(w);
  }
  for (; i < args.length; i++) {
    const w = args[i] as Word;
    if (!w.literal || w.glob) return { ok: false, reason: "find argument is not a plain word" };
    if (FIND_BARE.has(w.text)) continue;
    if (!FIND_VALUED.has(w.text)) return { ok: false, reason: `unrecognized find option ${w.text}` };
    i++;
    if (i >= args.length) return { ok: false, reason: `find ${w.text} has no value` };
    if (args[i]?.glob) return { ok: false, reason: "unquoted glob in a find predicate" };
    if (w.text === "-newer" || w.text === "-samefile") paths.push(args[i] as Word);
  }
  return { ok: true, paths };
}

const TEST_FILE_OPS = new Set([
  "-e",
  "-f",
  "-d",
  "-r",
  "-w",
  "-x",
  "-s",
  "-L",
  "-h",
  "-O",
  "-G",
  "-S",
  "-b",
  "-c",
  "-p",
  "-nt",
  "-ot",
  "-ef",
]);

/** An awk program that can run commands or write files is not read-only. */
const AWK_UNSAFE = /system\s*\(|getline|>|\||ENVIRON|\bprintf?\b[^;}]*\)\s*>/;

/** Does the command only read? `args` are the words after the command name. */
export function classify(name: string, args: Word[]): Classified {
  if (name === "find") return classifyFind(args);
  if (name === "git") return classifyGit(args);
  const spec = SPECS[name];
  if (spec === undefined) return { ok: false, reason: `${name} is not a built-in read-only command` };
  return classifyWith(name, spec, args);
}

function classifyGit(args: Word[]): Classified {
  let i = 0;
  while (args[i]?.text === "--no-pager") i++;
  const sub = args[i]?.text;
  const spec = sub === undefined ? undefined : GIT[sub];
  if (sub === undefined || spec === undefined) return { ok: false, reason: `git ${sub ?? ""} is not a read-only form` };
  const rest = args.slice(i + 1);
  if (sub === "branch") {
    const listing = rest.some(
      (w) => w.text === "--list" || w.text === "-l" || w.text.startsWith("--contains") || w.text.startsWith("--merged"),
    );
    const bare = rest.filter((w) => !w.text.startsWith("-"));
    if (bare.length > 0 && !listing) return { ok: false, reason: "git branch with a name creates a branch" };
    return classifyWith("git branch", { ...spec, args: "words" }, rest);
  }
  return classifyWith(`git ${sub}`, spec, rest);
}

function classifyWith(name: string, spec: Spec, args: Word[]): Classified {
  const fail = (reason: string): Classified => ({ ok: false, reason: `${name}: ${reason}` });
  const paths: Word[] = [];
  const positional: Word[] = [];
  let patternGiven = false;
  let after = false;
  for (let i = 0; i < args.length; i++) {
    const w = args[i] as Word;
    if (!w.literal) return fail("argument is not literal");
    if (spec.strictGlob && w.glob) return fail("unquoted glob");
    const t = w.text;
    if (after || spec.raw || t === "-" || !t.startsWith("-") || (name === "date" && t.startsWith("+"))) {
      positional.push(w);
      continue;
    }
    if (t === "--") {
      after = true;
      continue;
    }
    if (w.glob) return fail("unquoted glob in an option");
    const takeValue = (attached: string | undefined, isPath: boolean, isPattern: boolean): Classified | undefined => {
      let value: Word | undefined;
      if (attached !== undefined) value = { text: attached, literal: true, glob: false };
      else {
        value = args[++i];
        if (value === undefined) return fail(`${t} needs a value`);
      }
      if (!value.literal) return fail("option value is not literal");
      if (isPath) paths.push(value);
      else if (value.glob) return fail("unquoted glob in a value position");
      if (isPattern) patternGiven = true;
      return undefined;
    };
    if (t.startsWith("--")) {
      const eq = t.indexOf("=");
      const key = eq < 0 ? t.slice(2) : t.slice(2, eq);
      const attached = eq < 0 ? undefined : t.slice(eq + 1);
      if (spec.long?.includes(key) && attached === undefined) continue;
      const isPath = spec.longPath?.includes(key) === true;
      if (isPath || spec.longValued?.includes(key)) {
        const bad = takeValue(attached, isPath, spec.patternOpts?.includes(key) === true);
        if (bad) return bad;
        continue;
      }
      if (spec.long?.includes(key)) return fail(`--${key} takes no value`);
      return fail(`unrecognized option ${t}`);
    }
    if (spec.number && /^-\d+$/.test(t)) continue;
    for (let c = 1; c < t.length; c++) {
      const ch = t.charAt(c);
      if (spec.flags?.includes(ch)) continue;
      const isPath = spec.pathValued?.includes(ch) === true;
      if (!isPath && !spec.valued?.includes(ch)) return fail(`unrecognized option -${ch}`);
      const rest = t.slice(c + 1);
      const bad = takeValue(rest === "" ? undefined : rest, isPath, spec.patternOpts?.includes(ch) === true);
      if (bad) return bad;
      break;
    }
  }
  switch (spec.args) {
    case "none":
      if (positional.length > 0) return fail("takes no arguments");
      break;
    case "words":
      if (positional.some((w) => w.glob)) return fail("unquoted glob in a word position");
      if (name === "test") return classifyTest(positional);
      if (name === "date" && positional.some((w) => !w.text.startsWith("+"))) return fail("date would set the clock");
      break;
    case "paths":
      paths.push(...positional);
      break;
    case "pattern": {
      const pattern = patternGiven ? undefined : positional[0];
      const files = patternGiven ? positional : positional.slice(1);
      if (pattern?.glob) return fail("unquoted glob in the pattern position");
      if (name === "awk" && pattern !== undefined && AWK_UNSAFE.test(pattern.text))
        return fail("awk program can run or write");
      if (name === "awk" && patternGiven) return fail("awk -f");
      paths.push(...files);
      break;
    }
  }
  return { ok: true, paths };
}

function classifyTest(args: Word[]): Classified {
  const paths: Word[] = [];
  args.forEach((w, i) => {
    const prev = args[i - 1]?.text ?? "";
    if (TEST_FILE_OPS.has(prev) || TEST_FILE_OPS.has(args[i + 1]?.text ?? "")) paths.push(w);
  });
  return { ok: true, paths: paths.filter((w) => !TEST_FILE_OPS.has(w.text)) };
}
