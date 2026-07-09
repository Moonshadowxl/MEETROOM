// meetroom web viewer — read-only dashboard polling daemon state.
// Plain JS on purpose: no build tooling (V1 open-decision recommendation).

const params = new URLSearchParams(location.search);
let sessionId = params.get("session");
const token = params.get("token"); // for remote sessions

function headers() {
  const h = { "content-type": "application/json" };
  if (token) h["x-meetroom-token"] = token;
  const opKey = localStorage.getItem("meetroom-operator-key");
  if (opKey) h["x-meetroom-operator"] = opKey;
  return h;
}

// V7 #5 — the viewer acts, using the same HTTP API as the CLI.
async function act(method, path, body) {
  const res = await fetch(path, { method, headers: headers(), body: body ? JSON.stringify(body) : undefined });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || data.ok === false) alert(data.error || `HTTP ${res.status}`);
  refresh();
}

async function fetchJson(path) {
  const res = await fetch(path, { headers: headers() });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

function el(tag, cls, text) {
  const node = document.createElement(tag);
  if (cls) node.className = cls;
  if (text !== undefined) node.textContent = text;
  return node;
}

function empty(container, label) {
  container.replaceChildren(el("div", "empty", label));
}

async function loadSessionList() {
  const picker = document.getElementById("session-picker");
  try {
    const data = await fetchJson("/api/sessions");
    picker.replaceChildren();
    for (const s of data.sessions) {
      const opt = el("option", "", `${s.id} — ${s.cwd}`);
      opt.value = s.id;
      picker.appendChild(opt);
    }
    if (!sessionId && data.sessions.length) sessionId = data.sessions[data.sessions.length - 1].id;
    if (sessionId) picker.value = sessionId;
  } catch {
    empty(document.getElementById("agents"), "daemon unreachable");
  }
  picker.onchange = () => {
    sessionId = picker.value;
    const url = new URL(location.href);
    url.searchParams.set("session", sessionId);
    history.replaceState(null, "", url);
    refresh();
  };
}

function agentName(session, id) {
  if (id === "human") return "human";
  if (id === "system") return "system";
  const a = session.agents.find((x) => x.id === id);
  return a ? a.name : id;
}

function render(session) {
  const statusEl = document.getElementById("session-status");
  statusEl.textContent = session.status;
  statusEl.className = `pill ${session.status}`;
  const pauseBtn = document.getElementById("pause-btn");
  pauseBtn.textContent = session.status === "paused" ? "resume" : "pause";
  pauseBtn.style.display = session.status === "ended" ? "none" : "";
  pauseBtn.onclick = () => act("POST", `/api/sessions/${session.id}/${session.status === "paused" ? "resume" : "pause"}`);

  const agents = document.getElementById("agents");
  agents.replaceChildren();
  if (!session.agents.length) empty(agents, "nobody has joined yet");
  for (const a of session.agents) {
    const card = el("div", "card");
    card.appendChild(el("div", "", `${a.name} — ${a.role}`));
    const bits = [a.status];
    if (a.costTier) bits.push(`tier: ${a.costTier}`);
    if (a.vibe) bits.push(a.vibe);
    card.appendChild(el("div", "meta", bits.join(" · ")));
    agents.appendChild(card);
  }

  const claims = document.getElementById("claims");
  claims.replaceChildren();
  if (!session.claims.length) empty(claims, "no active claims");
  for (const c of session.claims) {
    const card = el("div", "card");
    card.appendChild(el("div", "", c.filepath));
    const waiting = (session.waitlists.find((w) => w.filepath === c.filepath) || {}).waitingAgentIds || [];
    card.appendChild(
      el("div", "meta", `${agentName(session, c.agentId)} (${c.status})${waiting.length ? ` · ${waiting.length} waiting` : ""}`)
    );
    claims.appendChild(card);
  }

  const proposals = document.getElementById("proposals");
  proposals.replaceChildren();
  const open = session.proposals.filter((p) => p.status !== "resolved" && p.status !== "rejected");
  if (!open.length) empty(proposals, "no open proposals");
  for (const p of open) {
    const card = el("div", "card");
    const head = el("div", p.status === "escalated" ? "escalated" : "");
    head.textContent = `[${p.status}] ${p.content}`;
    card.appendChild(head);
    card.appendChild(el("div", "meta", `${p.id} · by ${agentName(session, p.authorId)} · ${p.objections.length} objections${p.votes ? ` · votes: ${p.votes.filter((v) => v.vote === "yes").length}y/${p.votes.filter((v) => v.vote === "no").length}n` : ""}`));
    if (p.status === "escalated" || p.status === "open" || p.status === "contested") {
      const actions = el("div", "actions");
      const resolveBtn = el("button", "btn approve", "resolve");
      resolveBtn.onclick = () => act("POST", `/api/sessions/${session.id}/proposals/${p.id}/resolve`, { agentId: "human" });
      actions.appendChild(resolveBtn);
      card.appendChild(actions);
    }
    proposals.appendChild(card);
  }

  const board = document.getElementById("board");
  board.replaceChildren();
  for (const lane of ["todo", "in-progress", "review", "blocked", "done"]) {
    const laneEl = el("div", "lane");
    laneEl.appendChild(el("h3", "", lane));
    const tasks = session.tasks.filter((t) => t.status === lane);
    for (const t of tasks) {
      const card = el("div", `card status-${lane}`);
      card.appendChild(el("div", "", t.title));
      const meta = [t.id, t.assignedAgentId ? agentName(session, t.assignedAgentId) : "unassigned"];
      if (t.estimatedComplexity) meta.push(t.estimatedComplexity);
      card.appendChild(el("div", "meta", meta.join(" · ")));
      laneEl.appendChild(card);
    }
    board.appendChild(laneEl);
  }

  const reviews = document.getElementById("reviews");
  reviews.replaceChildren();
  if (!session.reviews.length) empty(reviews, "no reviews yet");
  for (const r of session.reviews) {
    const card = el("div", "card");
    const line = el("div", "", `${r.id} — task ${r.taskId} — ${r.status}`);
    if (r.authorConfidence) line.appendChild(el("span", "tag", `confidence: ${r.authorConfidence}`));
    if (r.prUrl) {
      const a = el("a", "tag", "PR");
      a.href = r.prUrl;
      a.target = "_blank";
      line.appendChild(a);
    }
    card.appendChild(line);
    card.appendChild(
      el("div", "meta", `by ${agentName(session, r.authorAgentId)}${r.reviewerAgentId ? ` · reviewed by ${agentName(session, r.reviewerAgentId)}` : ""} · ${r.comments.length} comments`)
    );
    if (r.status === "pending") {
      const actions = el("div", "actions");
      const ok = el("button", "btn approve", "approve");
      ok.onclick = () => act("POST", `/api/sessions/${session.id}/reviews/${r.id}/decide`, { agentId: "human", decision: "approved" });
      const no = el("button", "btn reject", "request changes");
      no.onclick = () => {
        const comment = prompt("what needs to change?");
        if (comment) act("POST", `/api/sessions/${session.id}/reviews/${r.id}/decide`, { agentId: "human", decision: "changes-requested", comment });
      };
      actions.appendChild(ok);
      actions.appendChild(no);
      card.appendChild(actions);
    }
    reviews.appendChild(card);
  }

  const chat = document.getElementById("chat");
  const stickChat = chat.scrollTop + chat.clientHeight >= chat.scrollHeight - 20;
  chat.replaceChildren();
  for (const m of session.chatLog.slice(-200)) {
    const msg = el("div", "msg");
    const who = agentName(session, m.agentId);
    const whoEl = el("span", `who ${m.agentId === "system" ? "system" : m.agentId === "human" ? "human" : ""}`, who);
    msg.appendChild(whoEl);
    if (m.to) msg.appendChild(el("span", "private", ` → ${agentName(session, m.to)} (private)`));
    msg.appendChild(document.createTextNode(`: ${m.message}`));
    chat.appendChild(msg);
  }
  if (stickChat) chat.scrollTop = chat.scrollHeight;

  const timeline = document.getElementById("timeline");
  timeline.replaceChildren();
  for (const e of session.events.slice(-100).reverse()) {
    const row = el("div", "msg");
    row.appendChild(el("span", "who", e.ts.slice(11, 19)));
    row.appendChild(document.createTextNode(` ${e.type}${e.agentId ? ` (${agentName(session, e.agentId)})` : ""}`));
    timeline.appendChild(row);
  }
}

async function refresh() {
  if (!sessionId) return;
  try {
    const data = await fetchJson(`/api/sessions/${sessionId}/state`);
    render(data.session);
  } catch {
    // daemon briefly unreachable — keep last render
  }
}

// Operator key (V6/V7): stored locally, sent on every request.
const opKeyInput = document.getElementById("op-key");
opKeyInput.value = localStorage.getItem("meetroom-operator-key") || "";
opKeyInput.onchange = () => localStorage.setItem("meetroom-operator-key", opKeyInput.value.trim());

// prompt-all from the viewer.
document.getElementById("prompt-box").addEventListener("keydown", (e) => {
  if (e.key !== "Enter" || !sessionId) return;
  const message = e.target.value.trim();
  if (!message) return;
  e.target.value = "";
  act("POST", `/api/sessions/${sessionId}/say`, { agentId: "human", message });
});

loadSessionList().then(refresh);
setInterval(refresh, 2000);
setInterval(loadSessionList, 15000);
