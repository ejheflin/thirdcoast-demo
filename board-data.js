/* ═══════════════════════════════════════════════════════════════════
   board-data.js — everything between the API and the board.

   gamenight.html is presentation. This file is the plumbing, kept
   separate because it is the part /display has to reimplement in Go
   and it is easier to argue with on its own.

   THREE SOURCES, tried in order:

     1. a live server        /api/night?date=YYYY-MM-DD
     2. the captured night   data/night-2026-09-01.json
     3. baked-in fallback    the constants at the bottom of this file

   Source 2 is real data — captured from the live LeagueApps API on
   2026-08-26 and regenerated offline by
   `go run ./prototype/tools/nightfixture`. Source 3 exists so the page
   still works opened straight off the filesystem, where fetch() is
   blocked for both of the others.

   Query params (dev only):
     ?api=http://host:8080   point at a server on another origin
     ?date=2026-09-01        which night
     ?slot=0..3              which slot counts as "now"
     ?slot=live              derive it from the real wall clock
     ?src=fallback           force the baked data

   ── WHAT THE API DOES NOT CARRY ────────────────────────────────────
   Generating the fixture made three gaps visible that reading the Go
   structs did not. All three are real work for /display:

   1. NO CAPTAIN NAMES. schedule.Team is {id, name}. The board shows
      "JT N." beside every team; not one of those is in the API. They
      came from a human. Either another endpoint supplies them or the
      caption comes off the card.

   2. NO COURT COLOURS. The API returns "Court 7"; that court is
      painted black, and nothing in the data model knows it. The COURT
      table below is hand-maintained and has no home in the schema —
      the single most load-bearing piece of the whole visual system is
      currently a constant in a prototype.

   3. NO LIVENESS. `state` is scheduled | rescheduled |
      played_regular_time. Nothing says "being played right now", and
      in the captured night all 48 games are `scheduled`. Live has to
      be derived from the wall clock against the slot, which means the
      board is guessing. On a night running 20 minutes late it guesses
      wrong. Whether /control should assert it instead is an open
      question worth putting to the coordinator.

   Two smaller shape differences, handled here rather than at render:
   league names arrive prefixed ("Tuesday Coed 4s A"), and team names
   in the 2s leagues carry their standings seed ("1. Liz C. and
   Madison P.").
   ═══════════════════════════════════════════════════════════════════ */

/* The venue's real painted courts. "The pink court" is what players
   actually say, which is the whole argument for colour-coding.

   `faint` marks the three under 3:1 against the board's ground — black
   1.05:1, maroon 2.18:1, dark green 2.67:1 — which get a sand ring.
   Do not edit these by eye: prototype/check-contrast.mjs asserts the
   flags in both directions against the tokens in gamenight.html. */
const COURT = {
  1:  {name:"lime green", hex:"#8CC63F", ink:"#0A0A0A"},
  2:  {name:"orange",     hex:"#F2872F", ink:"#0A0A0A"},
  3:  {name:"blue",       hex:"#2F72C4", ink:"#FFFFFF"},
  4:  {name:"maroon",     hex:"#8E2F3F", ink:"#FFFFFF", faint:true},
  5:  {name:"dark green", hex:"#1F6B3A", ink:"#FFFFFF", faint:true},
  6:  {name:"yellow",     hex:"#F2CE2F", ink:"#0A0A0A"},
  7:  {name:"black",      hex:"#151515", ink:"#FFFFFF", faint:true},
  8:  {name:"pink",       hex:"#E86FA8", ink:"#0A0A0A"},
  9:  {name:"purple",     hex:"#8455C4", ink:"#FFFFFF"},
  10: {name:"white",      hex:"#F4F4F2", ink:"#0A0A0A"},
  11: {name:"red",        hex:"#D93A32", ink:"#FFFFFF"},
  12: {name:"tan",        hex:"#C9A87C", ink:"#0A0A0A"},
};

/* The physical floor. Three banks, confirmed by the client (handoff
   section 4). The centre bank has only two courts; below them is the
   bar, which is why the venue mark fills that space on the board.

     NORTH (left)   CENTRE      SOUTH (right)
         8            6              1
         9            7              2
        10        [ THE BAR ]        3
        11                           4
        12                           5

   Same problem as COURT: this is venue truth with no home in the data
   model. A court that LeagueApps reports but this map does not know
   still has to appear somewhere, so the renderer appends it rather
   than dropping it — losing a live game off the board would be far
   worse than an out-of-place card. */
const FLOOR = { left: [8, 9, 10, 11, 12], mid: [6, 7], right: [1, 2, 3, 4, 5] };

const Q = new URLSearchParams(location.search);

/* ── shape fixes ──────────────────────────────────────────────── */

/* "Tuesday Coed 4s A" -> "Coed 4s A". The night already says which day
   it is; repeating it in twelve league tags wastes the width team
   names need. */
const trimLeague = s => s.replace(/^(Mon|Tues|Wednes|Thurs|Fri|Satur|Sun)day\s+/i, "");

/* Team names are three fields in a trench coat. Every one of the 48
   looks like one of these:

     "6. Bombaclat (Aatir A.)"            seed, name, captain
     "1. Carolina Beach Bumpers (Ashton)" captain with no surname
     "1. Liz C. and Madison P."           a 2s pair, no captain
     "3. Save a Horse, Dig a Volleyball (Sarah F.)"   commas in the name

   So the captains are NOT missing from the API, which is what an
   earlier pass concluded from reading schedule.Team {id, name}. They
   are in there, just encoded rather than modelled — along with the
   standings seed. Both are worth having: the seed orders the Tonight
   list the way the standings do, and the captain is the caption the
   board wants under each team.

   Deliberately tolerant. A name that matches nothing comes back whole
   with no seed and no captain, which renders fine. */
function parseTeam(raw) {
  const s = String(raw || "");
  const m = /^(?:(\d+)\.\s+)?(.*?)(?:\s+\(([^()]*)\))?\s*$/.exec(s);
  if (!m) return { seed: null, name: s, cap: "" };
  return {
    seed: m[1] ? +m[1] : null,
    name: (m[2] || s).trim(),
    cap: (m[3] || "").trim(),
  };
}

/* "Court 7" -> 7. Anything that does not end in a number gets 0, which
   renders as a bare slab rather than throwing. */
const courtNo = s => { const m = /(\d+)\s*$/.exec(s || ""); return m ? +m[1] : 0; };

/* "20:30" -> "8:30". The venue talks in 12-hour; upstream is 24.
   Returns null, not a guess, when there is no parseable time — the first
   version returned `${...}:${String(undefined).padStart(2,"0")}` for a
   timeless game, which put the literal string "12:undefined" on the
   board. A playoff night has no times at all (the coordinator assigns
   courts as they free up), so that was not hypothetical. */
const to12 = t => {
  const parts = String(t || "").split(":");
  const h = Number(parts[0]), m = Number(parts[1]);
  if (!Number.isFinite(h) || !Number.isFinite(m)) return null;
  return `${((h + 11) % 12) + 1}:${String(m).padStart(2, "0")}`;
};

/* ── the adapter ──────────────────────────────────────────────── */

function adapt(night) {
  /* Only real, parseable times become slots. A playoff night has none —
     drop straight through to timeless mode rather than inventing one. */
  const slots = [...new Set(night.games.map(g => g.time))]
    .filter(t => to12(t) !== null).sort();
  const timeless = slots.length === 0;

  /* Which slot is "now". The API cannot tell us (see gap 3), so this
     is derived, and the derivation is a guess the board presents as a
     fact. ?slot=live uses the real clock; otherwise a fixed index so
     the prototype is reviewable at any hour. */
  let cur;
  if (timeless) {
    /* Nothing to be "current" relative to. Every game is on now, which
       is exactly right for a tournament: the court board IS the state. */
    cur = null;
  } else if (Q.get("slot") === "live") {
    const d = new Date(), mins = d.getHours() * 60 + d.getMinutes();
    cur = slots.findIndex(s => {
      const [h, m] = s.split(":").map(Number);
      return mins < h * 60 + m + 60;          // a slot owns the hour after it starts
    });
    if (cur < 0) cur = slots.length - 1;
  } else {
    const n = parseInt(Q.get("slot"), 10);
    cur = Number.isInteger(n) ? Math.max(0, Math.min(slots.length - 1, n)) : Math.min(2, slots.length - 1);
  }

  const shape = list => list
    .map(g => {
      const h = parseTeam(g.home.name), a = parseTeam(g.away.name);
      return {
        c:  courtNo(g.court),
        lg: trimLeague(g.leagueName),
        h:  h.name, hc: h.cap, hs: h.seed,
        a:  a.name, ac: a.cap, as: a.seed,
      };
    })
    .sort((x, y) => x.c - y.c);

  /* A timeless night (tournament) has no slot to filter by — the whole
     court board is "now". */
  const allGames = () => shape(night.games);
  const forSlot = t => shape(night.games.filter(g => g.time === t));

  /* Tonight: which courts each league occupies in each slot, and how
     many games. Built from the games themselves rather than declared,
     so a court override shows up here automatically. */
  const leagues = night.leagues.map(l => {
    const mine = night.games.filter(g => g.programId === l.programId);
    return {
      n: trimLeague(l.name),
      perSlot: slots.map(t => {
        const gs = mine.filter(g => g.time === t);
        return {
          courts: [...new Set(gs.map(g => courtNo(g.court)))].sort((a, b) => a - b),
          n: gs.length,
        };
      }),
    };
  });

  /* ── the Tonight pane, rebuilt around TEAMS ────────────────────
     Leagues on the row axis answered "where is my league playing",
     which nobody asks — a player knows their league and wants their
     own team. So: league is a grouping header, each team is a row,
     each slot a column, and a cell says which court and against whom.

     Every team plays exactly 2 of the 4 slots on this night, so half
     of every row is empty. That is not waste — "you are not playing
     at 7:30" is the answer half the time.

     48 teams plus 5 headers is 53 rows and about 22 fit on a 1080
     screen at twenty-foot type. So this returns PAGES, and the
     rotation grows by however many there are. */
  const teamsByLeague = night.leagues.map(l => {
    const mine = night.games.filter(g => g.programId === l.programId);
    const rows = new Map();
    for (const g of mine) {
      for (const [me, opp] of [[g.home, g.away], [g.away, g.home]]) {
        const t = parseTeam(me.name), o = parseTeam(opp.name);
        if (!rows.has(t.name)) rows.set(t.name, { name: t.name, cap: t.cap, seed: t.seed, bySlot: {} });
        rows.get(t.name).bySlot[g.time] = { court: courtNo(g.court), opp: o.name };
      }
    }
    const teams = [...rows.values()].sort((a, b) =>
      (a.seed ?? 99) - (b.seed ?? 99) || a.name.localeCompare(b.name));
    return { n: trimLeague(l.name), teams };
  }).sort((a, b) => a.n.localeCompare(b.n));

  /* ── how much of the night to show ────────────────────────────────
     A coordinator control, not a data property: on a busy night the
     board can be collapsed to just what is happening.

       window=now    Playing now only. Rotation stops rotating.
       window=soon   Playing now + Up next.
       window=all    everything (default).

       past=hide     the Tonight grid drops elapsed slot columns. At
                     8:30 that turns four columns into two, which is
                     where most of the collapsing actually comes from —
                     the team names get the reclaimed width.

     Wired to query params here so the idea is testable before /control
     exists. In the real thing these are operator toggles, and the board
     re-renders on the next poll. */
  const win = ["now", "soon", "all"].includes(Q.get("window")) ? Q.get("window") : "all";
  const hidePast = Q.get("past") === "hide" && cur != null;

  /* which slot columns the Tonight grid shows, and where "now" sits
     among them once elapsed ones are dropped */
  const gridIdx = slots.map((_, i) => i).filter(i => !hidePast || i >= cur);
  const gridSlots = gridIdx.map(i => ({ raw: slots[i], label: to12(slots[i]) }));
  const gridCur = cur == null ? null : gridIdx.indexOf(cur);

  return {
    date:  night.date,
    kind:  night.kind,
    timeless,
    slots: slots.map(to12),
    rawSlots: slots,
    cur,
    window: win,
    showNext:    win !== "now",
    showTonight: win === "all",
    gridSlots,
    gridCur: gridCur < 0 ? null : gridCur,
    now:   timeless ? allGames() : forSlot(slots[cur]),
    next:  !timeless && cur + 1 < slots.length ? forSlot(slots[cur + 1]) : [],
    nextLabel: !timeless && cur + 1 < slots.length ? to12(slots[cur + 1]) : null,
    leagues,
    teamsByLeague,
    pages: paginate(teamsByLeague, 22),
    /* the selected Tonight layout: a card per league, two card columns.
       52px rows and 118px of card chrome are the measured values behind
       38px team names — see prototype/tonight.html layout E. */
    cardPages: packCards(teamsByLeague, 52, 118, 830, 2),
    total: night.games.length,
  };
}

/* Place each league card in whichever column has the most room left,
   and never split a card across a page break. Returns pages, each page
   an array of columns, each column {items, used}. */
function packCards(leagues, rowH, chrome, budget, cols) {
  const pages = [];
  let page = Array.from({ length: cols }, () => ({ items: [], used: 0 }));
  const flush = () => {
    if (page.some(c => c.items.length)) pages.push(page);
    page = Array.from({ length: cols }, () => ({ items: [], used: 0 }));
  };
  for (const lg of leagues) {
    const h = chrome + lg.teams.length * rowH;
    let best = null;
    for (const c of page) if (c.used + h <= budget && (!best || c.used < best.used)) best = c;
    if (!best) { flush(); best = page[0]; }
    best.items.push(lg); best.used += h;
  }
  flush();
  return pages;
}

/* Pack whole leagues onto pages without splitting one across a break
   unless it cannot fit alone. A league header costs a row too. */
function paginate(leagues, budget) {
  const pages = [];
  let page = [], used = 0;
  for (const lg of leagues) {
    const cost = lg.teams.length + 1;
    if (used && used + cost > budget) { pages.push(page); page = []; used = 0; }
    if (cost > budget) {                       // a league too big for one page
      let rest = lg.teams;
      while (rest.length) {
        const room = budget - 1;
        const take = rest.slice(0, room);
        pages.push([{ n: lg.n, teams: take, cont: rest.length > room }]);
        rest = rest.slice(room);
      }
      continue;
    }
    page.push(lg); used += cost;
  }
  if (page.length) pages.push(page);
  return pages;
}

/* ── loading ──────────────────────────────────────────────────── */

async function tryFetch(url) {
  try {
    const r = await fetch(url, { cache: "no-store" });
    if (!r.ok) return null;
    const j = await r.json();
    return j && j.night ? j : null;
  } catch { return null; }        // file://, offline, no server — all fine
}

async function loadBoard() {
  const date = Q.get("date") || "2026-09-01";

  if (Q.get("src") !== "fallback") {
    const api = (Q.get("api") || "").replace(/\/$/, "");
    for (const [url, label] of [
      [`${api}/api/night?date=${encodeURIComponent(date)}`, api ? `live · ${api}` : "live · this origin"],
      [`data/night-${date}.json`, "captured night"],
    ]) {
      const j = await tryFetch(url);
      if (j) {
        const m = adapt(j.night);
        m.source = label;
        m.syncedAt = j.syncedAt || "";
        return m;
      }
    }
  }

  const m = adapt(FALLBACK);
  m.source = "baked-in fallback";
  return m;
}

/* ── source 3: baked-in fallback ──────────────────────────────────
   Real teams, real courts, in the API's own shape — including team
   names encoded the way LeagueApps actually encodes them, "3. Gold
   Diggerz (JT N.)", so parseTeam is exercised identically on all three
   sources and `adapt` is the only path into the board.               */
const FALLBACK = {
  date: "2026-09-01",
  kind: "game_night",
  leagues: [
    {programId: 1, name: "Tuesday Coed 4s A"},
    {programId: 2, name: "Tuesday Coed 4s B"},
    {programId: 3, name: "Tuesday Coed 4s BB"},
    {programId: 4, name: "Tuesday Coed 4s Upper Rec"},
    {programId: 5, name: "Tuesday Womens 2s A"},
  ],
  games: [],
};

/* Built rather than typed, so the four slots stay consistent. Courts
   follow the real Tuesday allocation: A on 2-3, B on 1/8/9, BB on 4-5,
   Upper Rec on 10-12, Womens 2s on 6-7. */
(function buildFallback() {
  const rounds = [
    /* 18:30 */ [
      [1,2,"Gold Diggerz","Milk"],[2,1,"Hustle Gang","Toodles"],[3,1,"Score Check","Team Jacob"],
      [4,3,"Chocolate City","Not Good at Volleyball Puns"],[5,3,"Net Ninjas","3 OGs and Bae"],
      [6,5,"Beth B. and Julia V.","Yanni S. and Ali M."],[7,5,"Erika P. and Becca W.","Juli T. and Lauren W."],
      [8,2,"Bad Hombres","Volley Llamas"],[9,2,"The Replacements","Big Dig Energy"],
      [10,4,"Gold Star for Effort","The Volleybeaners"],[11,4,"Sets Pistols","BLT"],[12,4,"What Court Are We On?","Offense Only"],
    ],
    /* 19:30 */ [
      [1,2,"Milk","Volley Llamas"],[2,1,"Toodles","Team Jacob"],[3,1,"Score Check","Hustle Gang"],
      [4,3,"Not Good at Volleyball Puns","3 OGs and Bae"],[5,3,"Net Ninjas","Chocolate City"],
      [6,5,"Erika P. and Becca W.","Beth B. and Julia V."],[7,5,"Yanni S. and Ali M.","Juli T. and Lauren W."],
      [8,2,"Bad Hombres","Big Dig Energy"],[9,2,"Gold Diggerz","The Replacements"],
      [10,4,"Sets Pistols","What Court Are We On?"],[11,4,"BLT","The Volleybeaners"],[12,4,"Gold Star for Effort","Offense Only"],
    ],
  ];
  const caps = {
    "Gold Diggerz":"JT N.", "Milk":"Sean M.", "Hustle Gang":"Calvin D.", "Toodles":"Michael L.",
    "Score Check":"Julianna T.", "Team Jacob":"Mark J.", "Chocolate City":"Samanda H.",
    "Not Good at Volleyball Puns":"Daniel A.", "Net Ninjas":"Katelyn M.", "3 OGs and Bae":"Johnny W.",
    "Bad Hombres":"Jaimie M.", "Volley Llamas":"Daphne D.", "The Replacements":"Joe R.",
    "Big Dig Energy":"Chad S.", "Gold Star for Effort":"Merilyn V.", "The Volleybeaners":"Emanuel N.",
    "Sets Pistols":"Christina Z.", "BLT":"Sean B.", "What Court Are We On?":"Bear S.", "Offense Only":"Zhen Y.",
  };
  const NAMES = {1:"Tuesday Coed 4s A",2:"Tuesday Coed 4s B",3:"Tuesday Coed 4s BB",
                 4:"Tuesday Coed 4s Upper Rec",5:"Tuesday Womens 2s A"};

  /* stable seed per team, so the Tonight rows sort the same way twice */
  const seeds = {};
  let nextSeed = {};
  const seedOf = (prog, team) => {
    const k = prog + "|" + team;
    if (!(k in seeds)) seeds[k] = (nextSeed[prog] = (nextSeed[prog] || 0) + 1);
    return seeds[k];
  };
  /* encode exactly as LeagueApps does: "<seed>. <name> (<captain>)" */
  const encode = (prog, team) => {
    const s = seedOf(prog, team), c = caps[team];
    return `${s}. ${team}${c ? ` (${c})` : ""}`;
  };

  let id = 1;
  ["18:30","19:30","20:30","21:30"].forEach((t, i) => {
    for (const [court, prog, home, away] of rounds[i % 2]) {
      FALLBACK.games.push({
        activityId: id++, programId: prog, leagueName: NAMES[prog], time: t,
        court: `Court ${court}`, state: "scheduled",
        home: {id: id, name: encode(prog, home)},
        away: {id: id + 1000, name: encode(prog, away)},
      });
    }
  });
})();


/* ═══ the wall clock the board screens show ═════════════════════════
   Every playoff screen used to carry a literal in its markup -- 8:47 on
   the Tonight and Winners screens, 9:26 on the Grand Final -- which is
   fine for a screenshot and wrong on a television that people in the
   room can compare against their own phones.

   The screens rebuild themselves with innerHTML on every poll, so a
   clock cannot be painted once and left: startClock re-queries on each
   tick rather than holding an element, which means a redraw between
   ticks cannot orphan it. The template calls clockText() as it builds,
   so a freshly drawn screen is already right and never shows a stale
   minute waiting for the next tick.

   12-hour with no leading zero and no meridiem, matching what
   gamenight.html has always rendered. */
function clockText(d = new Date()) {
  return `${((d.getHours() + 11) % 12) + 1}:${String(d.getMinutes()).padStart(2, "0")}`;
}

/* The date beside it. playoff.html derives its own from the feed's date
   field, which is the better source and stays; this is for the screens
   that had no feed date to hand and were carrying a hardcoded
   "Tuesday, September 15" instead -- a date that disagreed with the
   Tonight screen two rotations earlier. */
function todayLabel(d = new Date()) {
  return d.toLocaleDateString("en-US", {weekday: "long", month: "long", day: "numeric"});
}

/* Ten seconds: the clock shows minutes, so this is worst-case ten
   seconds of staleness on a wall that nobody reads to the second. */
function startClock() {
  const paint = () => {
    for (const el of document.querySelectorAll("[data-clock]")) el.textContent = clockText();
    for (const el of document.querySelectorAll("[data-today]")) el.textContent = todayLabel();
  };
  paint();
  setInterval(paint, 10000);
}
