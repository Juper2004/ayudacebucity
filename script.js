 // -----------------------------------------------------------------------------
// Application data and constants
// -----------------------------------------------------------------------------
const BARANGAYS = ["Adlaon", "Agsungot", "Apas", "Babag", "Bacayan", "Banilad", "Basak Pardo",
    "Basak San Nicolas", "Binaliw", "Bonbon", "Budlaan", "Buhisan", "Bulacao", "Buot-Taup",
    "Busay", "Calamba", "Cambinocot", "Capitol Site", "Carreta", "Central", "Cogon Pardo",
    "Cogon Ramos", "Day-as", "Duljo Fatima", "Ermita", "Guadalupe", "Guba", "Hippodromo",
    "Inayawan", "Kalubihan", "Kalunasan", "Kamagayan", "Kamputhaw (Camputhaw)", "Kasambagan",
    "Kinasang-an Pardo", "Labangon", "Lahug", "Lorega San Miguel", "Lusaran", "Luz", "Mabini",
    "Mabolo", "Malubog", "Mambaling", "Pahina Central", "Pahina San Nicolas", "Pamutan",
    "Pari-an", "Paril", "Pasil", "Pit-os", "Poblacion Pardo", "Pulangbato", "Pung-ol-Sibugay",
    "Punta Princesa", "Quiot Pardo", "Sambag I", "Sambag II", "San Antonio", "San Jose",
    "San Nicolas Central", "San Roque", "Santa Cruz", "Sawang Calero", "Sinsin", "Sirao",
    "Suba (Suba San Nicolas)", "Sudlon I", "Sudlon II", "Sapangdaku", "T. Padilla",
    "Tabunan", "Tagbao", "Talamban", "Taptap", "Tejero", "Tinago", "Tisa", "To-ong Pardo", "Zapatera"];
const seedRequests = [];
const seedDonations = [];
// Relief records are still a browser prototype. Accounts and sessions belong to the server.
const STORAGE = { requests: "ayudaRequestsProV3", donations: "ayudaDonationsProV3" };
const dashboardDataCache = { userId: null, requests: null, donations: null, loading: null, error: "" };
const notificationState = { userId: null, items: null, unreadCount: 0, loading: null, error: "" };
const storageWarnings = new Map();
const recoveryAttempts = new Map();
const authState = { user: null, users: [], ready: false, error: "" };
let authRevision = 0;
let recoveryEmail = "";
let recoveryResendAt = 0;
let recoverySending = false;
const accountActions = new Set();
// -----------------------------------------------------------------------------
// Local storage and session helpers
// -----------------------------------------------------------------------------
function validRecords(records, kind) {
    const fields = {
        requests: ["id", "household", "barangay", "category", "disaster", "urgency", "description", "status"],
        donations: ["id", "donor", "type", "amount", "status"]
    }[kind];
    return Array.isArray(records) && records.every(record => record && typeof record === "object" && !Array.isArray(record)
    && fields.every(field => typeof record[field] === "string") && record.id.length > 0) && new Set(records.map(record => record.id)).size === records.length;
}
function readRecords(kind, missing = []) {
    const key = STORAGE[kind];
    let raw;
    try {
        raw = localStorage.getItem(key);
        if (raw === null) {
            const initial = JSON.parse(JSON.stringify(missing));
            if (!commitRecords({ [kind]: initial }))
                return [];
            return initial;
        }
        const records = JSON.parse(raw);
        if (!validRecords(records, kind))
            throw new Error("Invalid saved records");
        return records;
    }
    catch (error) {
        if (raw !== undefined && raw !== null) {
            // Preserve damaged data before recovering. Never replace it if backup fails.
            if (recoveryAttempts.get(key) !== raw) {
                recoveryAttempts.set(key, raw);
                const backupKey = key + "CorruptBackup-" + newId("RECOVERY");
                try {
                    localStorage.setItem(backupKey, raw);
                    localStorage.setItem(key, "[]");
                    storageWarnings.set(key, `Some saved ${kind} could not be read. The original data was preserved in a recovery backup; those records need to be restored.`);
                }
                catch {
                    storageWarnings.set(key, `Saved ${kind} could not be read or backed up. The original data has been kept; changes are blocked until browser storage is repaired.`);
                }
            }
        }
        else {
            storageWarnings.set(key, `Saved ${kind} could not be accessed. Check browser storage settings before making changes.`);
        }
        return [];
    }
}
function commitRecords(changes) {
    const entries = Object.entries(changes), previous = new Map(), written = [];
    try {
        for (const [kind, records] of entries) {
            if (!Object.hasOwn(STORAGE, kind) || !validRecords(records, kind))
                throw new Error("Invalid records");
            const raw = localStorage.getItem(STORAGE[kind]);
            // Do not overwrite data that could not be safely recovered.
            if (raw !== null && !validRecords(JSON.parse(raw), kind))
                throw new Error("Unrecovered records");
            previous.set(kind, raw);
        }
        for (const [kind, records] of entries) {
            localStorage.setItem(STORAGE[kind], JSON.stringify(records));
            written.push(kind);
        }
        return true;
    }
    catch {
        for (const kind of written.reverse()) {
            try {
                const raw = previous.get(kind);
                if (raw === null)
                    localStorage.removeItem(STORAGE[kind]);
                else
                    localStorage.setItem(STORAGE[kind], raw);
            }
            catch {
                storageWarnings.set("rollback", "A storage error interrupted saving. Reload and check the affected records before continuing.");
            }
        }
        storageWarnings.set("save", "Changes could not be saved. Check available browser storage and try again.");
        try {
            toast("Changes could not be saved. Check available browser storage and try again.");
        }
        catch { }
        renderStorageNotice();
        return false;
    }
}
function renderStorageNotice() {
    if (!storageWarnings.size)
        return;
    let notice = document.getElementById("storageNotice");
    if (!notice) {
        notice = document.createElement("div");
        notice.id = "storageNotice";
        notice.className = "storage-notice";
        notice.setAttribute("role", "alert");
        document.body.appendChild(notice);
    }
    notice.textContent = [...new Set(storageWarnings.values())].join(" ");
}
function newId(prefix) {
    const token = globalThis.crypto?.randomUUID?.() || Date.now().toString(36) + "-" + Math.random().toString(36).slice(2);
    return prefix + "-" + token;
}
function init() {
    readRecords("requests", seedRequests);
    readRecords("donations", seedDonations);
    migrateOwnership();
    expirePledges();
}
const getUsers = () => authState.users;
function dashboardDataActor() {
    const actor = session();
    const roles = ["HOUSEHOLD", "BARANGAY_OFFICIAL", "DONOR", "DSWS_ADMIN"];
    return actor && roles.includes(actor.role) && (actor.role === "HOUSEHOLD" || actor.status === "APPROVED") ? actor : null;
}
const getRequests = () => {
    const actor = dashboardDataActor();
    if (actor)
        return dashboardDataCache.userId === actor.id && Array.isArray(dashboardDataCache.requests) ? dashboardDataCache.requests : [];
    return readRecords("requests");
};
const setRequests = v => commitRecords({ requests: v });
const getDonations = () => {
    const actor = dashboardDataActor();
    if (actor)
        return dashboardDataCache.userId === actor.id && Array.isArray(dashboardDataCache.donations) ? dashboardDataCache.donations : [];
    return readRecords("donations");
};
const setDonations = v => commitRecords({ donations: v });
const session = () => authState.user;
let tabSessionIdPromise;
function getTabSessionId() {
    if (!tabSessionIdPromise) tabSessionIdPromise = createTabSessionId();
    return tabSessionIdPromise;
}
async function createTabSessionId() {
    // This selector is not a login token. The server keeps tokens in HttpOnly cookies.
    const freshId = () => Array.from(crypto.getRandomValues(new Uint8Array(16)), byte => byte.toString(16).padStart(2, "0")).join("");
    let id;
    try { id = sessionStorage.getItem("ayudaTabId"); } catch { }
    if (!/^[a-f0-9]{32}$/.test(id || "")) id = freshId();
    if (navigator.locks?.request) {
        // Duplicated tabs and window.open can copy sessionStorage. Only one live
        // document may own a selector; the browser releases its lock on unload.
        const claim = candidate => new Promise((resolve, reject) => {
            navigator.locks.request("ayuda-tab-" + candidate, { ifAvailable: true }, lock => {
                resolve(Boolean(lock));
                if (lock) return new Promise(() => {});
            }).catch(reject);
        });
        try {
            while (!await claim(id)) id = freshId();
        }
        catch { id = freshId(); }
    }
    try { sessionStorage.setItem("ayudaTabId", id); } catch { /* Keep this tab isolated in memory when storage is blocked. */ }
    return id;
}
async function authHeaders(json = false) {
    return {
        Accept: "application/json",
        "X-Ayuda-Tab": await getTabSessionId(),
        ...(json ? { "Content-Type": "application/json" } : {})
    };
}
async function api(path, body) {
    if (!/^https?:$/.test(location.protocol))
        throw new Error("Start AYUDA with npm start, then open http://localhost:3000 to use accounts and email recovery.");
    const revision = authRevision;
    const headers = await authHeaders(body !== undefined);
    let response;
    try {
        response = await fetch(path, {
            method: body === undefined ? "GET" : "POST",
            credentials: "same-origin",
            headers,
            ...(body === undefined ? {} : { body: JSON.stringify(body) }),
            signal: AbortSignal.timeout(30000)
        });
    }
    catch {
        throw new Error("Cannot reach the AYUDA server. Check your connection and make sure the server is running, then try again.");
    }
    let data;
    try { data = await response.json(); }
    catch { throw new Error("The AYUDA backend is unavailable here. Start the app with npm start and open http://localhost:3000."); }
    if (!response.ok) {
        const error = new Error(data.message || data.error || "The request could not be completed. Please try again.");
        error.status = response.status;
        error.retryAfter = Math.max(0, Number(response.headers.get("Retry-After")) || 0);
        if (response.status === 401 && !path.startsWith("/api/auth/login") && revision === authRevision) {
            authRevision++;
            authState.user = null;
            authState.users = [];
            location.hash = "#/login";
        }
        throw error;
    }
    return data;
}
function refreshDashboardData(force = false) {
    const actor = dashboardDataActor();
    if (!actor)
        return Promise.resolve();
    if (dashboardDataCache.loading)
        return dashboardDataCache.loading;
    if (!force && dashboardDataCache.userId === actor.id && Array.isArray(dashboardDataCache.requests) && Array.isArray(dashboardDataCache.donations))
        return Promise.resolve();
    const userId = actor.id;
    if (dashboardDataCache.userId !== userId) {
        dashboardDataCache.requests = null;
        dashboardDataCache.donations = null;
    }
    dashboardDataCache.userId = userId;
    dashboardDataCache.error = "";
    dashboardDataCache.loading = Promise.all([api("/api/requests"), api("/api/donations")]).then(([requestData, donationData]) => {
        if (!Array.isArray(requestData.requests) || !Array.isArray(donationData.donations))
            throw new Error("The server returned invalid dashboard data.");
        if (dashboardDataActor()?.id === userId) {
            dashboardDataCache.requests = requestData.requests;
            dashboardDataCache.donations = donationData.donations;
        }
    }).catch(error => {
        dashboardDataCache.error = error.message;
        throw error;
    }).finally(() => {
        dashboardDataCache.loading = null;
    });
    return dashboardDataCache.loading;
}
function refreshNotifications(force = false) {
    const actor = dashboardDataActor();
    if (!actor)
        return Promise.resolve();
    if (notificationState.loading)
        return notificationState.loading;
    if (!force && notificationState.userId === actor.id && Array.isArray(notificationState.items))
        return Promise.resolve();
    const userId = actor.id;
    if (notificationState.userId !== userId) {
        notificationState.items = null;
        notificationState.unreadCount = 0;
    }
    notificationState.userId = userId;
    notificationState.error = "";
    notificationState.loading = api("/api/notifications").then(data => {
        if (!Array.isArray(data.notifications) || !Number.isInteger(data.unreadCount))
            throw new Error("The server returned invalid notifications.");
        if (dashboardDataActor()?.id === userId) {
            notificationState.items = data.notifications;
            notificationState.unreadCount = data.unreadCount;
        }
    }).catch(error => {
        notificationState.error = error.message;
        throw error;
    }).finally(() => {
        notificationState.loading = null;
    });
    return notificationState.loading;
}
async function refreshAuth() {
    const revision = ++authRevision;
    const { user } = await api("/api/auth/session");
    const users = user ? (await api("/api/accounts")).users : [];
    if (revision !== authRevision)
        return;
    authState.user = user;
    authState.users = users;
    authState.error = "";
}
function cacheAccount(user) {
    authState.users = [...authState.users.filter(account => account.id !== user.id), user];
    if (authState.user?.id === user.id)
        authState.user = user;
}
async function submitForm(event, busyLabel, action) {
    event.preventDefault();
    const form = event.currentTarget;
    if (form.dataset.busy === "true")
        return;
    const button = form.querySelector('button[type="submit"]');
    const label = button?.textContent;
    form.dataset.busy = "true";
    form.setAttribute("aria-busy", "true");
    if (button) { button.disabled = true; button.textContent = busyLabel; }
    try { await action(); }
    catch (error) { toast(error.message); }
    finally {
        delete form.dataset.busy;
        form.removeAttribute("aria-busy");
        if (button) { button.disabled = false; button.textContent = label; }
    }
}
function currentActor(role) {
    const user = session();
    return user && user.role === role && user.status === "APPROVED" ? user : null;
}
function ownsRequest(user, request) {
    return Boolean(user && request.householdId && request.householdId === user.id);
}
function migrateOwnership() {
    const requests = getRequests(), donations = getDonations();
    storageWarnings.delete("ownership");
    let requestsChanged = false, donationsChanged = false;
    for (const request of requests) {
        if (Object.hasOwn(request, "householdId"))
            continue;
        // Names cannot establish ownership across the old prototype and server accounts.
        request.householdId = null;
        requestsChanged = true;
    }
    for (const donation of donations) {
        if (Object.hasOwn(donation, "donorId"))
            continue;
        donation.donorId = null;
        donationsChanged = true;
    }
    const unresolvedRequests = requests.filter(request => request.householdId === null && request.household && request.barangay);
    const unresolvedDonations = donations.filter(donation => donation.donorId === null && donation.donor);
    const changes = {};
    if (requestsChanged)
        changes.requests = requests;
    if (donationsChanged)
        changes.donations = donations;
    if (Object.keys(changes).length)
        commitRecords(changes);
    if (unresolvedRequests.length || unresolvedDonations.length) {
        storageWarnings.set("ownership", "Some older records could not be safely matched to an account. They remain available to DSWS for review and have not been assigned to a household or donor.");
    }
}
async function logout() {
    const button = document.querySelector("#modalRoot .btn-primary");
    if (button?.disabled)
        return;
    if (button) button.disabled = true;
    try {
        await api("/api/auth/logout", {});
        authRevision++;
        authState.user = null;
        authState.users = [];
        location.hash = "#/";
        closeModal();
        render();
    }
    catch (error) {
        toast(error.message);
        if (button) button.disabled = false;
    }
}
window.confirmLogout = () => {
    showModal(`<div class="modal-confirm"><div class="modal-head"><div><div class="modal-eyebrow">Session</div><h2>Log out?</h2></div><button class="icon-btn modal-close" aria-label="Cancel log out" onclick="closeModal()">${svg("close")}</button></div>
    <p>Are you sure you want to log out of your AYUDA CEBU account?</p>
    <div class="modal-confirm-actions"><button class="btn btn-light" type="button" onclick="closeModal()">Cancel</button><button class="btn btn-primary" type="button" onclick="logout()">Log out</button></div></div>`);
};
function expirePledges() {
    return false;
}
// -----------------------------------------------------------------------------
// Shared UI helpers
// -----------------------------------------------------------------------------
function svg(name) {
    const icons = {
        menu: '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M4 7h16M4 12h16M4 17h16"/></svg>',
        close: '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M6 6l12 12M18 6L6 18"/></svg>',
        arrow: '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M5 12h14M13 6l6 6-6 6"/></svg>',
        logout: '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M10 17l5-5-5-5M15 12H3M14 4h5a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2h-5"/></svg>',
        shield: '<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M12 3l7 3v5c0 4.7-3 8.8-7 10-4-1.2-7-5.3-7-10V6l7-3z"/><path d="M9 12l2 2 4-4"/></svg>',
        users: '<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M22 21v-2a4 4 0 0 0-3-3.87M16 3.13a4 4 0 0 1 0 7.75"/></svg>',
        heart: '<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M20.8 4.6a5.5 5.5 0 0 0-7.8 0L12 5.6l-1-1a5.5 5.5 0 0 0-7.8 7.8l1 1L12 21l7.8-7.6 1-1a5.5 5.5 0 0 0 0-7.8z"/></svg>',
        chart: '<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M3 3v18h18"/><path d="M7 16l4-5 3 3 5-7"/></svg>',
        eye: '<svg width="20" height="20" viewBox="0 0 64 64" aria-hidden="true"><path d="M7 32C14 22 22 17 32 17C42 17 50 22 57 32C50 42 42 47 32 47C22 47 14 42 7 32Z" fill="none" stroke="currentColor" stroke-width="4" stroke-linecap="round" stroke-linejoin="round"/><circle cx="32" cy="32" r="10" fill="none" stroke="currentColor" stroke-width="4"/><circle cx="32" cy="32" r="4" fill="currentColor"/></svg>',
        eyeOff: '<svg width="20" height="20" viewBox="0 0 64 64" aria-hidden="true"><path d="M7 32C14 22 22 17 32 17C42 17 50 22 57 32C50 42 42 47 32 47C22 47 14 42 7 32Z" fill="none" stroke="currentColor" stroke-width="4" stroke-linecap="round" stroke-linejoin="round"/><circle cx="32" cy="32" r="10" fill="none" stroke="currentColor" stroke-width="4"/><path d="M18 18L46 46" stroke="currentColor" stroke-width="4" stroke-linecap="round"/></svg>',
        home: '<svg width="19" height="19" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="M3 10.5 12 3l9 7.5"/><path d="M5 9.5V21h14V9.5"/><path d="M9 21v-7h6v7"/></svg>',
        plus: '<svg width="19" height="19" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M12 5v14M5 12h14"/></svg>',
        list: '<svg width="19" height="19" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round"><path d="M8 6h13M8 12h13M8 18h13"/><path d="M3 6h.01M3 12h.01M3 18h.01"/></svg>',
        bell: '<svg width="19" height="19" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="M18 8a6 6 0 0 0-12 0c0 7-3 7-3 9h18c0-2-3-2-3-9"/><path d="M10 21h4"/></svg>',
        user: '<svg width="19" height="19" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="8" r="4"/><path d="M4 21a8 8 0 0 1 16 0"/></svg>',
        check: '<svg width="19" height="19" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m5 12 4 4L19 6"/></svg>',
        search: '<svg width="19" height="19" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round"><circle cx="11" cy="11" r="7"/><path d="m20 20-4-4"/></svg>',
        gift: '<svg width="19" height="19" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="M20 12v9H4v-9M2 7h20v5H2zM12 7v14"/><path d="M12 7H7.5a2.5 2.5 0 1 1 2.1-3.85L12 7Zm0 0h4.5a2.5 2.5 0 1 0-2.1-3.85L12 7Z"/></svg>',
        building: '<svg width="19" height="19" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="M4 21V5l8-3 8 3v16"/><path d="M9 21v-5h6v5M8 8h.01M12 8h.01M16 8h.01M8 12h.01M12 12h.01M16 12h.01"/></svg>',
        map: '<svg width="19" height="19" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="m3 6 6-3 6 3 6-3v15l-6 3-6-3-6 3V6Z"/><path d="M9 3v15M15 6v15"/></svg>',
        report: '<svg width="19" height="19" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="M6 2h9l5 5v15H6z"/><path d="M14 2v6h6M10 17v-4M14 17v-7M18 17v-2"/></svg>'
    };
    return icons[name] || "";
}
function brand(href = "#/") { return `<a href="${escapeHtml(href)}" class="brand" aria-label="AYUDA CEBU home"><span class="brand-mark" aria-hidden="true"></span><span class="brand-copy brand-copy-fallback">AYUDA CEBU<small>CEBU CITY</small></span></a>`; }
function dashboardTabIcon(tab) {
    const icons = {
        overview: "home", request: "plus", history: "list", profile: "user",
        accounts: "check", pending: "list", all: "list", browse: "search",
        donations: "gift", officials: "users", barangays: "map", requests: "list", reports: "report"
    };
    return svg(icons[tab] || "list");
}
function toast(msg) {
    document.querySelector(".toast")?.remove();
    const d = document.createElement("div");
    d.className = "toast";
    d.setAttribute("role", "status");
    d.setAttribute("aria-live", "polite");
    d.textContent = msg;
    document.body.appendChild(d);
    setTimeout(() => d.remove(), 2400);
}
function formatDate(value) {
    const date = new Date(value);
    return value && Number.isFinite(date.getTime()) ? new Intl.DateTimeFormat("en-PH", { month: "short", day: "numeric", year: "numeric", hour: "numeric", minute: "2-digit" }).format(date) : "—";
}
function hoursSince(value) { return Math.floor((Date.now() - new Date(value).getTime()) / 3600000); }
function escapeHtml(value) {
    return String(value ?? "").replace(/[&<>"']/g, char => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[char]));
}
function toInlineJsArg(value) { return escapeHtml(JSON.stringify(String(value ?? ""))); }
const ASSISTANCE_CATEGORIES = ["Food", "Water", "Medical", "Shelter", "Utility"];
function categoryOptions() { return ASSISTANCE_CATEGORIES.map(category => `<option>${escapeHtml(category)}</option>`).join(""); }
function badge(x) {
    const label = String(x ?? "");
    let c = label.toLowerCase().replace(/\s+/g, "-").replace(/[^a-z0-9-]/g, "");
    if (label === "Under Verification")
        c = "pending";
    return `<span class="badge ${c}">${escapeHtml(label)}</span>`;
}
function urgencyBadge(value) { return badge(value); }
function barangayOptions(selected = "") { return BARANGAYS.map(barangay => `<option ${barangay === selected ? "selected" : ""}>${escapeHtml(barangay)}</option>`).join(""); }
function route() { return location.hash.replace(/^#\/?/, "").split("?")[0].split("/").filter(Boolean); }
function requireRole(role) {
    const user = session();
    if (!user || user.role !== role || (role !== "HOUSEHOLD" && user.status !== "APPROVED")) {
        location.hash = "#/login";
        return false;
    }
    return true;
}
// -----------------------------------------------------------------------------
// Public pages
// -----------------------------------------------------------------------------
function publicHeader() {
    return `<header class="site-nav"><div class="container nav-inner">${brand()}
    <nav class="desktop-nav"><a href="#/about">About</a><a href="#/how">How it works</a><a href="#/security">Trust & transparency</a></nav>
    <div class="nav-actions">
      <a class="btn btn-light btn-sm" href="#/login">Log in</a>
      <a class="btn btn-primary btn-sm" href="#/register">Create account</a>
      <button class="icon-btn menu-btn" aria-label="Toggle navigation menu" aria-controls="mobileMenu" aria-expanded="false" onclick="toggleMenu()">${svg("menu")}</button>
    </div>
  </div></header>
  <div id="mobileMenu" class="mobile-menu hidden">
    <a href="#/about" onclick="toggleMenu()">About</a>
    <a href="#/how" onclick="toggleMenu()">How it works</a>
    <a href="#/security" onclick="toggleMenu()">Trust & transparency</a>
        <a class="btn btn-light btn-block" href="#/login" onclick="toggleMenu()">Log in</a>
    <a class="btn btn-primary btn-block" href="#/register">Create account</a>
  </div>`;
}
window.toggleMenu = () => {
    const menu = document.getElementById("mobileMenu");
    if (!menu)
        return;
    const hidden = menu.classList.toggle("hidden");
    document.querySelector('[aria-controls="mobileMenu"]')?.setAttribute("aria-expanded", String(!hidden));
};
function landing() {
    return `<div class="landing-page">${publicHeader()}
    <main id="mainContent">
      <section class="landing-hero" aria-labelledby="landing-title">
        <div class="container landing-hero-grid">
          <div class="landing-hero-copy">
            <div class="landing-eyebrow">Tabang. Paglaum. Panaghiusa.</div>
            <h1 id="landing-title">Together, <span>help reaches</span> further.</h1>
            <p>A clearer way to request, verify, and support relief across Cebu City.</p>
            <div class="landing-actions">
              <a class="btn btn-primary" href="#/register?role=household">Request assistance ${svg("arrow")}</a>
              <a class="btn btn-dark" href="#/register?role=donor">Support a verified need</a>
            </div>
            <div class="landing-proof" aria-label="Platform coverage and process">
              <span>${svg("users")}80 barangays</span>
              <span>${svg("shield")}Barangay verification</span>
              <span>${svg("chart")}DSWS oversight</span>
            </div>
          </div>
          <div class="landing-hero-art">
            <ol class="landing-preview" aria-label="How a request moves through the platform">
              <li class="landing-preview-step landing-preview-request">
                <span class="landing-preview-icon" aria-hidden="true">${svg("report")}</span>
                <span class="landing-preview-copy"><span class="landing-preview-label">Step 01</span><strong>Request received</strong></span>
                <span class="landing-preview-arrow" aria-hidden="true">${svg("arrow")}</span>
              </li>
              <li class="landing-preview-step landing-preview-verify">
                <span class="landing-preview-icon" aria-hidden="true">${svg("shield")}</span>
                <span class="landing-preview-copy"><span class="landing-preview-label">Step 02</span><strong>Barangay verified</strong></span>
                <span class="landing-preview-arrow" aria-hidden="true">${svg("arrow")}</span>
              </li>
              <li class="landing-preview-step landing-preview-support">
                <span class="landing-preview-icon" aria-hidden="true">${svg("heart")}</span>
                <span class="landing-preview-copy"><span class="landing-preview-label">Step 03</span><strong>Support matched</strong></span>
              </li>
            </ol>
            <img src="hero.png" alt="Illustration of a Cebu City family receiving relief supplies from a volunteer, with a city skyline behind them" width="1730" height="909" fetchpriority="high">
          </div>
        </div>
      </section>

      <section id="about" class="landing-section landing-roles" aria-labelledby="about-title">
        <div class="container">
          <div class="landing-eyebrow">Built for a stronger Cebu</div>
          <h2 id="about-title">One system. A more resilient Cebu City.</h2>
          <p class="landing-intro">AYUDA CEBU connects households, barangay officials, donors, and DSWS through one coordinated relief platform.</p>
          <div class="landing-card-grid landing-three">
            <article class="landing-card"><span class="landing-card-icon">${svg("users")}</span><h3>Households</h3><strong>Submit needs without losing visibility.</strong><p>Residents can file relief requests and follow their status from submission to fulfilment.</p></article>
            <article class="landing-card"><span class="landing-card-icon">${svg("shield")}</span><h3>Barangay officials</h3><strong>Verify and coordinate faster.</strong><p>Assigned barangay officials review accounts and requests before confirming fulfilment.</p></article>
            <article class="landing-card"><span class="landing-card-icon">${svg("heart")}</span><h3>Donors</h3><strong>Support with confidence.</strong><p>Pledge to a household need or make a general donation for community support.</p></article>
          </div>
        </div>
      </section>

      <section id="how" class="landing-section landing-how" aria-labelledby="how-title">
        <div class="container">
          <div class="landing-eyebrow">How help moves</div>
          <h2 id="how-title">A simple flow, with accountability built in.</h2>
          <div class="landing-card-grid landing-four">
            <article class="landing-card landing-flow-card"><div class="landing-flow-top"><span class="landing-flow-number">1</span><span class="landing-card-icon">${svg("report")}</span></div><h3>Request</h3><p>A household files a relief request under its Cebu City barangay.</p></article>
            <article class="landing-card landing-flow-card"><div class="landing-flow-top"><span class="landing-flow-number">2</span><span class="landing-card-icon">${svg("shield")}</span></div><h3>Verify</h3><p>The assigned barangay reviews the request while donors can reserve support.</p></article>
            <article class="landing-card landing-flow-card"><div class="landing-flow-top"><span class="landing-flow-number">3</span><span class="landing-card-icon">${svg("heart")}</span></div><h3>Match</h3><p>Donors pledge to pending or approved needs. Each pledge lasts 48 hours from creation.</p></article>
            <article class="landing-card landing-flow-card"><div class="landing-flow-top"><span class="landing-flow-number">4</span><span class="landing-card-icon">${svg("chart")}</span></div><h3>Track</h3><p>Fulfilment is recorded while DSWS monitors the citywide picture.</p></article>
          </div>
        </div>
      </section>

      <section id="security" class="landing-section landing-trust" aria-labelledby="trust-title">
        <div class="container">
          <div class="landing-eyebrow">Built on trust</div>
          <h2 id="trust-title">A clearer view of relief in Cebu City.</h2>
          <p class="landing-intro">Each role has a clear part to play, from submitting a need to recording fulfilment.</p>
          <div class="landing-card-grid landing-three">
            <article class="landing-card landing-trust-card"><span class="landing-card-icon">${svg("shield")}</span><h3>Barangay verification</h3><p>The assigned barangay reviews requests before fulfilment can be confirmed.</p></article>
            <article class="landing-card landing-trust-card"><span class="landing-card-icon">${svg("report")}</span><h3>Clear request status</h3><p>Households can see where their request stands as it moves through the process.</p></article>
            <article class="landing-card landing-trust-card"><span class="landing-card-icon">${svg("chart")}</span><h3>DSWS oversight</h3><p>Requests awaiting verification for over 72 hours are surfaced for attention.</p></article>
          </div>
        </div>
      </section>

      <section class="landing-section landing-cta-section" aria-labelledby="cta-title">
        <div class="container">
          <div class="landing-cta">
            <div class="landing-cta-copy">
              <div class="landing-eyebrow">Start here</div>
              <h2 id="cta-title">Ready to request help or give support?</h2>
              <p>Choose the path that matches your role. Barangay and DSWS accounts are created administratively.</p>
              <div class="landing-actions">
                <a class="btn btn-primary" href="#/register?role=household">Request assistance ${svg("arrow")}</a>
                <a class="btn btn-light" href="#/register?role=donor">Become a donor</a>
              </div>
            </div>
            <img class="landing-cta-art" src="banner.png" alt="" width="2169" height="725" loading="lazy" decoding="async">
          </div>
        </div>
      </section>
    </main>

    <footer class="footer landing-footer">
      <div class="container footer-grid">
        <div>${brand()}<p class="small" style="margin-top:12px">Tabang. Paglaum. Panaghiusa.</p></div>
        <div><strong class="small">Platform</strong><p class="small">Household<br>Barangay<br>Donor<br>DSWS</p></div>
        <div><strong class="small">Coverage</strong><p class="small">Cebu City<br>80 barangays</p></div>
      </div>
    </footer>
  </div>`;
}
// -----------------------------------------------------------------------------
// Authentication
// -----------------------------------------------------------------------------
function authShell(content) {
    return `<div class="auth-shell">
    <aside class="auth-brand">
      ${brand()}
      <div class="auth-story">
        <div class="auth-eyebrow"><span aria-hidden="true"></span>Tabang. Paglaum. Panaghiusa.</div>
        <h2>Relief with<br><span>clarity.</span></h2>
        <p>Verified requests, direct-to-need assistance,<br class="auth-desktop-break"> and transparent citywide monitoring.</p>
      </div>
      <div class="auth-illustration" aria-hidden="true"></div>
      <p class="auth-attribution">Department of Social Welfare and Services &middot; Cebu City</p>
    </aside>
    <main id="mainContent" class="auth-main">
      <div class="auth-mobile-brand">${brand()}</div>
      <a class="auth-back" href="#/"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m12 5-7 7 7 7M5 12h14"/></svg>Back to home</a>
      <div class="auth-content">${authState.error ? `<div class="alert warning" role="alert">${escapeHtml(authState.error)}</div>` : ""}${content}</div>
    </main>
  </div>`;
}
function passwordToggleMarkup(id) {
    return `<button type="button" class="password-toggle" id="${id}Toggle" aria-label="Show password" title="Show password" onclick="togglePasswordVisibility('${id}')">${svg("eyeOff")}</button>`;
}
window.togglePasswordVisibility = id => {
    const input = document.getElementById(id);
    const toggle = document.getElementById(`${id}Toggle`);
    if (!input || !toggle)
        return;
    const isHidden = input.type === 'password';
    input.type = isHidden ? 'text' : 'password';
    toggle.innerHTML = isHidden ? svg('eye') : svg('eyeOff');
    toggle.setAttribute('aria-label', isHidden ? 'Hide password' : 'Show password');
    toggle.setAttribute('title', isHidden ? 'Hide password' : 'Show password');
};
function loginPage() {
    return authShell(`<div class="auth-card auth-card-login">
    <div class="kicker">Secure access</div>
    <h1>Welcome back</h1>
    <p>Log in to continue to your AYUDA CEBU portal.</p>
    <form class="form-grid" onsubmit="handleLogin(event)">
      <div class="field"><label for="loginEmail">Email address</label><input id="loginEmail" name="email" type="email" autocomplete="username" required placeholder="name@example.com"></div>
      <div class="field">
        <label for="loginPassword">Password</label>
        <div class="password-wrap">
          <input id="loginPassword" name="password" type="password" autocomplete="current-password" required placeholder="Enter your password">
          ${passwordToggleMarkup("loginPassword")}
        </div>
      </div>
      <p class="auth-help"><a href="#/forgot-password">Forgot password?</a></p>
      <button class="btn btn-primary btn-block" type="submit">Log in</button>
    </form>
    <p class="auth-switch">No account yet? <a href="#/register">Create an account</a></p>
  </div>`);
}
function forgotPasswordPage() {
        return authShell(`<div class="auth-card">
        <div class="kicker">Account recovery</div>
        <h1>Forgot password?</h1>
        <p>Enter the email address for your AYUDA account. If an account exists, we will request a password reset code for that address.</p>
        <form class="form-grid" onsubmit="handleForgotPassword(event)">
            <div class="field"><label for="recoveryEmail">Email address</label><input id="recoveryEmail" name="email" type="email" autocomplete="email" value="${escapeHtml(recoveryEmail)}" required placeholder="name@example.com"></div>
            <button class="btn btn-primary btn-block" type="submit">Send verification code</button>
        </form>
        <p class="auth-switch"><a href="#/login">Back to log in</a></p>
    </div>`);
}
function recoveryCodePage() {
        return authShell(`<div class="auth-card">
        <div class="kicker">Verify identity</div>
        <h1>Create a new password</h1>
        <p>If an account exists for <strong>${escapeHtml(recoveryEmail)}</strong>, a reset code has been requested. Check your inbox and spam folder, then enter the code below. Codes expire after 10 minutes.</p>
        <form class="form-grid" onsubmit="handlePasswordReset(event)">
            <div class="field"><label for="recoveryCode">Verification code</label><input id="recoveryCode" name="code" autocomplete="one-time-code" inputmode="numeric" pattern="[0-9]{6}" maxlength="6" required placeholder="Enter 6-digit code"></div>
            <div class="field"><label for="newPassword">New password</label><input id="newPassword" name="password" type="password" autocomplete="new-password" minlength="8" required placeholder="At least 8 characters"></div>
            <div class="field"><label for="confirmPassword">Confirm new password</label><input id="confirmPassword" name="confirmPassword" type="password" autocomplete="new-password" minlength="8" required placeholder="Repeat your new password"></div>
            <button class="btn btn-primary btn-block" type="submit">Create new password</button>
        </form>
        <p class="auth-help"><button id="resendRecovery" class="btn btn-light btn-sm" type="button" onclick="resendRecoveryCode()">Request another code</button></p>
        <p id="recoveryResendStatus" class="small muted" role="status"></p>
        <p class="auth-switch"><a href="#/forgot-password">Use a different email address</a></p>
        <p class="auth-switch"><a href="#/login">Back to log in</a></p>
    </div>`);
}
function formValue(id, trim = true) {
    const value = document.getElementById(id)?.value || "";
    return trim ? value.trim() : value;
}
function validEmail(value) { return value.length <= 254 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value); }
window.handleLogin = e => submitForm(e, "Logging in…", async () => {
    const email = formValue("loginEmail").toLowerCase();
    const password = formValue("loginPassword", false);
    const { user } = await api("/api/auth/login", { email, password });
    const dashboards = { HOUSEHOLD: "household", BARANGAY_OFFICIAL: "barangay", DONOR: "donor", DSWS_ADMIN: "dsws" };
    if (!Object.hasOwn(dashboards, user.role)) {
        toast("This account has an invalid role.");
        return;
    }
    if (user.role !== "HOUSEHOLD" && user.status !== "APPROVED") {
        toast(user.status === "REJECTED" ? "This account was rejected." : "This account is waiting for approval.");
        return;
    }
    authRevision++;
    authState.user = user;
    authState.users = [user];
    await refreshAuth();
    e.target.reset();
    location.hash = "#/" + dashboards[user.role];
});
function saveRecoveryEmail(email) {
    recoveryEmail = email;
    try {
        if (email) sessionStorage.setItem("ayudaRecoveryEmail", email);
        else sessionStorage.removeItem("ayudaRecoveryEmail");
    }
    catch { /* Recovery can continue in this tab when browser storage is unavailable. */ }
}
function updateRecoveryCooldown() {
    const button = document.getElementById("resendRecovery");
    const status = document.getElementById("recoveryResendStatus");
    if (!button || !status)
        return;
    const seconds = Math.max(0, Math.ceil((recoveryResendAt - Date.now()) / 1000));
    button.disabled = recoverySending || seconds > 0;
    button.textContent = recoverySending ? "Requesting code…" : "Request another code";
    status.textContent = seconds > 0 ? `You can request another code in ${seconds} seconds.` : "";
}
async function requestRecoveryCode(email) {
    recoverySending = true;
    updateRecoveryCooldown();
    try {
        await api("/api/auth/forgot-password", { email });
        recoveryResendAt = Date.now() + 60000;
        saveRecoveryEmail(email);
    }
    catch (error) {
        if (error.retryAfter)
            recoveryResendAt = Date.now() + error.retryAfter * 1000;
        throw error;
    }
    finally {
        recoverySending = false;
        updateRecoveryCooldown();
    }
}
window.handleForgotPassword = e => submitForm(e, "Requesting code…", async () => {
    const email = formValue("recoveryEmail").toLowerCase();
    if (!validEmail(email)) {
        toast("Enter a valid email address.");
        return;
    }
    if (recoverySending)
        return;
    if (email === recoveryEmail && Date.now() < recoveryResendAt) {
        location.hash = "#/reset-password";
        return;
    }
    await requestRecoveryCode(email);
    location.hash = "#/reset-password";
});
window.resendRecoveryCode = async () => {
    if (recoverySending || Date.now() < recoveryResendAt)
        return;
    if (!validEmail(recoveryEmail)) {
        location.hash = "#/forgot-password";
        return;
    }
    try {
        await requestRecoveryCode(recoveryEmail);
        toast("If an account exists, another reset code has been requested. Use the latest code you receive.");
    }
    catch (error) { toast(error.message); }
};
window.handlePasswordReset = e => submitForm(e, "Updating password…", async () => {
    const code = formValue("recoveryCode");
    const password = formValue("newPassword", false);
    const confirmation = formValue("confirmPassword", false);
    if (!validEmail(recoveryEmail)) {
        location.hash = "#/forgot-password";
        return;
    }
    if (!/^[0-9]{6}$/.test(code)) {
        toast("Enter the 6-digit code from your email.");
        return;
    }
    if (password.length < 8) {
        toast("Your new password must be at least 8 characters.");
        return;
    }
    if (password !== confirmation) {
        toast("The passwords do not match.");
        return;
    }
    await api("/api/auth/reset-password", { email: recoveryEmail, code, password });
    saveRecoveryEmail("");
    recoveryResendAt = 0;
    authRevision++;
    authState.user = null;
    authState.users = [];
    e.target.reset();
    toast("Your password has been updated.");
    location.hash = "#/login";
});
window.handleChangePassword = e => submitForm(e, "Changing password…", async () => {
    const currentPassword = formValue("currentPassword", false);
    const newPassword = formValue("newPasswordProfile", false);
    const confirmPassword = formValue("confirmPasswordProfile", false);
    if (!currentPassword) {
        toast("Enter your current password.");
        return;
    }
    if (newPassword.length < 8) {
        toast("Your new password must be at least 8 characters.");
        return;
    }
    if (newPassword !== confirmPassword) {
        toast("The new password and confirmation do not match.");
        return;
    }
    await api("/api/auth/change-password", { currentPassword, newPassword });
    e.target.reset();
    toast("Password changed successfully.");
});
function registerPage() {
    const q = new URLSearchParams(location.hash.split("?")[1] || "");
    const pre = q.get("role") || "";
    return authShell(`<div class="auth-card auth-card-register">
    <div class="kicker">Create account</div>
    <h1>Join AYUDA CEBU</h1>
    <p>Create an account to request or support relief in Cebu City.</p>
    <div class="auth-notice"><span class="auth-notice-icon" aria-hidden="true">i</span><p>Household accounts require barangay approval.<br>Official accounts require DSWS approval.</p></div>
    <form class="form-grid" onsubmit="handleRegister(event)">
      <div class="field">
        <label for="regRole">Account type</label>
        <select id="regRole" onchange="toggleReg()" required>
          <option value="">Select account type</option>
          <option value="HOUSEHOLD" ${pre === "household" ? "selected" : ""}>Household / Beneficiary</option>
          <option value="DONOR" ${pre === "donor" ? "selected" : ""}>Donor</option>
          <option value="BARANGAY_OFFICIAL" ${pre === "barangay" ? "selected" : ""}>Barangay Official</option>
        </select>
      </div>
      <div class="field"><label for="regName">Full name / Organization</label><input id="regName" name="name" autocomplete="name" required placeholder="Enter name"></div>
      <div id="regBarangayWrap" class="field ${["household", "barangay"].includes(pre) ? "" : "hidden"}">
        <label for="regBarangay">Barangay</label>
        <select id="regBarangay"><option value="">Select barangay</option>${barangayOptions()}</select>
      </div>
      <div id="regContactWrap" class="field ${["household", "barangay"].includes(pre) ? "" : "hidden"}">
        <label for="regContact">Contact number</label>
        <input id="regContact" type="tel" autocomplete="tel" placeholder="09XX XXX XXXX">
      </div>
      <div class="field"><label for="regEmail">Email address</label><input id="regEmail" name="email" type="email" autocomplete="email" required placeholder="name@example.com"></div>
      <div class="field"><label for="regPassword">Password</label><div class="password-wrap"><input id="regPassword" name="password" type="password" autocomplete="new-password" minlength="8" required placeholder="At least 8 characters">${passwordToggleMarkup("regPassword")}</div></div>
      <button class="btn btn-primary btn-block" type="submit">Create account</button>
    </form>
    <p class="auth-switch">Already registered? <a href="#/login">Log in</a></p>
  </div>`);
}
window.toggleReg = () => {
    const role = document.getElementById("regRole")?.value || "";
    const needsBarangayDetails = ["HOUSEHOLD", "BARANGAY_OFFICIAL"].includes(role);
    document.getElementById("regBarangayWrap")?.classList.toggle("hidden", !needsBarangayDetails);
    document.getElementById("regContactWrap")?.classList.toggle("hidden", !needsBarangayDetails);
};
window.handleRegister = e => submitForm(e, "Creating account…", async () => {
    const role = formValue("regRole"), name = formValue("regName"), email = formValue("regEmail").toLowerCase();
    const password = formValue("regPassword", false), barangay = formValue("regBarangay"), contact = formValue("regContact");
    if (!["HOUSEHOLD", "DONOR", "BARANGAY_OFFICIAL"].includes(role)) {
        toast("Select a valid account type.");
        return;
    }
    if (!name || name.length > 160 || !validEmail(email) || password.trim().length < 8) {
        toast("Enter a name, valid email, and password of at least 8 characters.");
        return;
    }
    if (["HOUSEHOLD", "BARANGAY_OFFICIAL"].includes(role) && !BARANGAYS.includes(barangay)) {
        toast("Select your barangay.");
        return;
    }
    if (["HOUSEHOLD", "BARANGAY_OFFICIAL"].includes(role) && (!contact || contact.length > 60)) {
        toast("Enter your contact number.");
        return;
    }
    await api("/api/auth/register", {
        email,
        password,
        role,
        name,
        barangay: ["HOUSEHOLD", "BARANGAY_OFFICIAL"].includes(role) ? barangay : null,
        contact: ["HOUSEHOLD", "BARANGAY_OFFICIAL"].includes(role) ? contact : null
    });
    e.target.reset();
    toast(["HOUSEHOLD", "BARANGAY_OFFICIAL"].includes(role)
        ? `Account created. Waiting for ${role === "HOUSEHOLD" ? "barangay" : "DSWS"} approval.`
        : "Account created successfully.");
    location.hash = "#/login";
});
// -----------------------------------------------------------------------------
// Dashboard shell and navigation
// -----------------------------------------------------------------------------
const DASHBOARD_CONFIG = {
    HOUSEHOLD: { title: "Household Portal", tabs: [["overview", "Home"], ["request", "New Request"], ["history", "My Requests"], ["profile", "Profile"]] },
    BARANGAY_OFFICIAL: { title: "Barangay Dashboard", tabs: [["overview", "Home"], ["accounts", "Account Verification", "Accounts"], ["pending", "Pending Requests", "Pending"], ["donations", "General Donations", "Donations"], ["all", "Requests"], ["profile", "Profile"]] },
    DONOR: { title: "Donor Portal", tabs: [["overview", "Home"], ["browse", "Browse"], ["donations", "Donations"], ["profile", "Profile"]] },
    DSWS_ADMIN: { title: "DSWS Dashboard", tabs: [["overview", "Home"], ["officials", "Barangay Officials", "Officials"], ["barangays", "Barangays"], ["requests", "Requests"], ["reports", "Reports"], ["profile", "Profile"]] }
};
function notificationTime(value) {
    const date = new Date(value);
    return value && Number.isFinite(date.getTime())
        ? new Intl.DateTimeFormat("en-PH", { timeZone: "Asia/Manila", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }).format(date)
        : "Time unavailable";
}
function notificationCenterMarkup() {
    const actor = dashboardDataActor();
    const ownsInbox = actor && notificationState.userId === actor.id;
    const count = ownsInbox ? notificationState.unreadCount : 0;
    const items = ownsInbox ? notificationState.items : null;
    const content = notificationState.error
        ? `<p class="notification-empty">${escapeHtml(notificationState.error)}</p>`
        : !Array.isArray(items)
            ? `<p class="notification-empty">Loading notifications…</p>`
            : items.length
                ? items.map(item => `<button class="notification-item${item.readAt ? "" : " is-unread"}" type="button" onclick="openNotification(${toInlineJsArg(item.id)},${toInlineJsArg(item.targetType)},${toInlineJsArg(item.targetId)})"><span class="notification-item-copy"><strong>${escapeHtml(item.title)}</strong><span>${escapeHtml(item.body)}</span><time datetime="${escapeHtml(item.createdAt)}">${escapeHtml(notificationTime(item.createdAt))}</time></span>${item.readAt ? "" : '<span class="notification-unread-dot" aria-label="Unread"></span>'}</button>`).join("")
                : `<p class="notification-empty">You’re all caught up.</p>`;
    return `<div class="notification-center">
      <button id="notificationToggle" class="icon-btn notification-toggle" type="button" aria-label="${count ? `${count} unread notifications` : "Notifications"}" aria-expanded="false" aria-controls="notificationPanel" title="Notifications" onclick="toggleNotificationPanel()">${svg("bell")}${count ? `<span class="notification-count" aria-hidden="true">${count > 99 ? "99+" : count}</span>` : ""}</button>
      <section id="notificationPanel" class="notification-panel" aria-label="Notifications" hidden>
        <header class="notification-panel-head"><strong>Notifications</strong><button type="button" class="notification-mark-all" onclick="markAllNotificationsRead()" ${count ? "" : "disabled"}>Mark all read</button></header>
        <div class="notification-list">${content}</div>
      </section>
    </div>`;
}
function dashShell(role, active, content) {
    const s = session();
    const cfg = DASHBOARD_CONFIG[role];
    if (!s || !cfg) return "";
    const dashboardRoutes = { HOUSEHOLD: "household", BARANGAY_OFFICIAL: "barangay", DONOR: "donor", DSWS_ADMIN: "dsws" };
    const dashboardHome = `#/${dashboardRoutes[role]}`;
    return `<div class="dashboard ${role === "DSWS_ADMIN" ? "dsws-dashboard" : ""} ${role === "DSWS_ADMIN" && active === "overview" ? "dsws-home" : ""}">
    <header class="dash-top">
      <div class="container dash-top-inner">
        ${brand(dashboardHome)}
        <div class="user-chip">
          <span class="system-status"><span class="system-status-dot"></span>Operational</span>
          <div class="user-meta"><strong class="small">${escapeHtml(s.name)}</strong><div class="small muted">${escapeHtml(cfg.title)}</div></div>
          ${notificationCenterMarkup()}
          <div class="avatar" aria-hidden="true">${escapeHtml(s.name.split(" ").map(x => x[0]).join("").slice(0, 2))}</div>
          <button class="icon-btn" aria-label="Log out" title="Log out" onclick="confirmLogout()">${svg("logout")}</button>
        </div>
      </div>
    </header>
    <div class="dash-layout">
      <aside class="sidebar" aria-label="${escapeHtml(cfg.title)} navigation">
        <div class="sidebar-branding">
          <span class="sidebar-eyebrow">Workspace</span>
          <strong>${escapeHtml(cfg.title)}</strong>
        </div>
        <nav class="side-nav">
          ${cfg.tabs.map(t => `<button class="side-btn ${active === t[0] ? "active" : ""}" ${active === t[0] ? 'aria-current="page"' : ""} onclick="goDash(${toInlineJsArg(role)},${toInlineJsArg(t[0])})"><span class="side-icon">${dashboardTabIcon(t[0])}</span><span>${escapeHtml(t[1])}</span></button>`).join("")}
        </nav>
        <div class="sidebar-note"><span class="sidebar-note-icon">${svg("shield")}</span><div><strong>Verified access</strong><p>Actions are limited to your assigned role.</p></div></div>
      </aside>
      <main id="mainContent" class="dash-main"><div class="container">${content}</div></main>
    </div>
    <nav class="mobile-bottom" aria-label="Mobile dashboard navigation">
      <div class="mobile-bottom-inner" style="grid-template-columns:repeat(${cfg.tabs.length},1fr)">${cfg.tabs.map(t => `<button class="mobile-nav-btn ${active === t[0] ? "active" : ""}" ${active === t[0] ? 'aria-current="page"' : ""} onclick="goDash(${toInlineJsArg(role)},${toInlineJsArg(t[0])})"><span class="mobile-nav-icon">${dashboardTabIcon(t[0])}</span><span>${escapeHtml(t[2] || t[1])}</span></button>`).join("")}</div>
    </nav>
  </div>`;
}
window.goDash = (role, tab) => {
    const routes = { HOUSEHOLD: "household", BARANGAY_OFFICIAL: "barangay", DONOR: "donor", DSWS_ADMIN: "dsws" };
    if (!routes[role] || !DASHBOARD_CONFIG[role]?.tabs.some(item => item[0] === tab)) return;
    location.hash = `#/${routes[role]}/${tab}`;
};
window.toggleNotificationPanel = () => {
    const panel = document.getElementById("notificationPanel");
    const button = document.getElementById("notificationToggle");
    if (!panel || !button) return;
    panel.hidden = !panel.hidden;
    button.setAttribute("aria-expanded", String(!panel.hidden));
};
window.addEventListener("click", event => {
    if (event.target instanceof Element && !event.target.closest(".notification-center")) {
        const panel = document.getElementById("notificationPanel");
        const button = document.getElementById("notificationToggle");
        if (panel && !panel.hidden) panel.hidden = true;
        button?.setAttribute("aria-expanded", "false");
    }
});
window.addEventListener("keydown", event => {
    if (event.key !== "Escape") return;
    const panel = document.getElementById("notificationPanel");
    const button = document.getElementById("notificationToggle");
    if (panel && !panel.hidden) {
        panel.hidden = true;
        button?.setAttribute("aria-expanded", "false");
        button?.focus();
    }
});
window.markAllNotificationsRead = async () => {
    try {
        await api("/api/notifications/read-all", {});
        await refreshNotifications(true);
        render();
    }
    catch (error) { toast(error.message); }
};
window.openNotification = async (id, targetType, targetId) => {
    try {
        await api(`/api/notifications/${encodeURIComponent(id)}/read`, {});
        await refreshNotifications(true);
        if (targetType === "chat" || targetType === "request_chat") await refreshDashboardData(true);
        render();
        if (targetType === "chat") window.openDonationChat(targetId);
        else if (targetType === "request_chat") window.openRequestChat(targetId);
        else if (targetType === "donation") window.openGeneralDonationDetails(targetId);
        else if (targetType === "request") window.openRequest(targetId);
    }
    catch (error) { toast(error.message); }
};
window.logout = logout;
function metricCard(value, label, micro = "") { return `<div class="metric-card"><div class="value">${escapeHtml(value)}</div><div class="label">${escapeHtml(label)}</div>${micro ? `<div class="micro">${escapeHtml(micro)}</div>` : ""}</div>`; }
function canRequestChat(request, actor = session()) {
    return Boolean(actor && request && actor.status === "APPROVED" &&
        ["Approved", "Pledged", "Fulfilled"].includes(request.status) &&
        ((actor.role === "HOUSEHOLD" && actor.id === request.householdId) ||
            (actor.role === "BARANGAY_OFFICIAL" && actor.barangay === request.barangay)));
}
function requestChatButton(request) {
    if (!canRequestChat(request)) return "";
    return `<button class="btn btn-light btn-sm" type="button" onclick="openRequestChat(${toInlineJsArg(request.id)})">${session().role === "HOUSEHOLD" ? "Chat with barangay" : "Chat with household"}</button>`;
}
function requestDetailActions(request) {
    return `<div class="actions"><button class="btn btn-light btn-sm" type="button" onclick="openRequest(${toInlineJsArg(request.id)})">Details</button>${requestChatButton(request)}</div>`;
}
function requestList(list, opts = {}) {
    if (!list.length)
        return `<div class="empty">No requests to show.</div>`;
    return `<div class="list">${list.map(r => `
    <div class="request-card">
      <div class="request-top">
        <div><strong>${escapeHtml(r.disaster || r.category)} Assistance</strong><div class="small muted" style="margin-top:3px">${escapeHtml(r.id)} • ${escapeHtml(opts.owner ? r.barangay : r.household + " • " + r.barangay)}</div></div>
        ${badge(r.status)}
      </div>
      <p>${escapeHtml(r.description)}</p>
      <div class="request-meta">${urgencyBadge(r.urgency)}<span>${escapeHtml(r.category)}</span><span>${formatDate(r.createdAt)}</span>${hoursSince(r.createdAt) >= 72 && r.status === "Under Verification" ? '<span>72h+ pending</span>' : ""}</div>
      ${opts.owner && r.rejectionReason ? `<div class="alert warning"><strong>Rejection reason:</strong> ${escapeHtml(r.rejectionReason)}</div>` : ""}
      ${opts.actions ? barangayActions(r) : opts.donor && ["Approved", "Under Verification"].includes(r.status) ? `<div class="actions"><button class="btn btn-primary btn-sm" onclick="openPledge(${toInlineJsArg(r.id)})">Pledge support</button><button class="btn btn-light btn-sm" onclick="openRequest(${toInlineJsArg(r.id)})">Details</button></div>` : requestDetailActions(r)}
    </div>`).join("")}</div>`;
}
function accountBadge(status) {
    const labels = { PENDING: "Pending", APPROVED: "Approved", REJECTED: "Rejected" };
    return badge(labels[status] || status);
}
function accountStatusPanel(user) {
    if (user.role !== "HOUSEHOLD" || user.status === "APPROVED")
        return "";
    if (user.status === "REJECTED") {
        return `<div class="alert warning"><strong>Account verification rejected.</strong> ${user.rejectionReason ? `Reason: ${escapeHtml(user.rejectionReason)}` : "Contact your barangay office for assistance."}</div>`;
    }
    return `<div class="alert info"><strong>Account verification pending.</strong> Your household account is waiting for approval from ${escapeHtml(user.barangay)}. You can log in and view your profile, but you cannot submit a relief request yet.</div>`;
}
function accountVerificationGate(user) {
    return `<div class="dsws-overview">${dswsPageHeading("Account verification", user.status === "REJECTED" ? "Account needs attention" : "Approval pending", user.status === "REJECTED" ? "Your barangay did not approve the account." : `Your household account must be approved by ${user.barangay} before you can submit a relief request.`)}
    ${accountStatusPanel(user)}
    <section class="dsws-panel dsws-detail-panel">${dswsPanelHeading("Verification details", svg("shield"))}<div class="dsws-panel-body">
      <div class="kv"><strong>Status</strong><span>${accountBadge(user.status)}</span></div>
      <div class="kv"><strong>Barangay</strong><span>${escapeHtml(user.barangay)}</span></div>
      <div class="kv"><strong>Registered</strong><span>${formatDate(user.createdAt)}</span></div>
      ${user.rejectionReason ? `<div class="kv"><strong>Reason</strong><span>${escapeHtml(user.rejectionReason)}</span></div>` : ""}
    </div></section></div>`;
}
// -----------------------------------------------------------------------------
// Household portal
// -----------------------------------------------------------------------------
function householdPage(tab = "overview") {
    if (!requireRole("HOUSEHOLD"))
        return "";
    const user = session();
    const requests = getRequests().filter(r => ownsRequest(user, r));
    const activeRequests = requests.filter(r => !["Fulfilled", "Rejected"].includes(r.status));
    const accountApproved = user.status === "APPROVED";
    let content = "";
    if (tab === "request") {
        content = accountApproved ? requestForm() : accountVerificationGate(user);
    }
    else if (tab === "history") {
        content = `<div class="dsws-overview">${dswsPageHeading("Request history", "My requests", "Track every request from verification to fulfilment.", accountApproved ? `<button class="dsws-report-button" onclick="goDash('HOUSEHOLD','request')">${svg("plus")}<span>New request</span>${svg("arrow")}</button>` : "")}
    ${accountStatusPanel(user)}
    <section class="dsws-panel dsws-table-panel">${dswsPanelHeading("Request history", svg("list"), "", requests.length)}${requestTable(requests, true)}</section></div>`;
    }
    else if (tab === "profile") {
        content = profilePanel(user);
    }
    else {
        content = `<div class="dsws-overview">${dswsPageHeading(user.barangay, `Good day, ${user.name.split(" ")[0]}.`, accountApproved ? "See your request status and submit new assistance when needed." : "Your household account must be approved by your barangay before you can submit relief requests.", accountApproved
            ? `<button class="dsws-report-button" onclick="goDash('HOUSEHOLD','request')">${svg("plus")}<span>Submit request</span>${svg("arrow")}</button>`
            : `<button class="dsws-report-button" disabled>${dswsSymbol("clock")}<span>Awaiting approval</span></button>`)}
    ${accountStatusPanel(user)}
    <div class="dsws-metrics">
      ${dswsMetric(requests.length, "Total requests", svg("report"), "blue")}
      ${dswsMetric(activeRequests.length, "Active requests", dswsSymbol("clock"), "amber")}
      ${dswsMetric(requests.filter(r => r.status === "Approved").length, "Approved", svg("shield"), "purple")}
      ${dswsMetric(requests.filter(r => r.status === "Fulfilled").length, "Fulfilled", svg("check"), "green")}
    </div>
    <div class="dsws-panels">
      <section class="dsws-panel">${dswsPanelHeading("Recent requests", svg("list"), `<button class="dsws-view-all" onclick="goDash('HOUSEHOLD','history')">View all <span aria-hidden="true">&rsaquo;</span></button>`)}<div class="dsws-panel-body">${requestList(requests.slice(0, 3), { owner: true })}</div></section>
      <section class="dsws-panel">${dswsPanelHeading(accountApproved ? "What happens next" : "Account verification", svg("shield"))}
        <div class="dsws-panel-body"><ol class="dsws-steps" role="list">
          ${accountApproved
            ? `<li class="dsws-step"><span class="dsws-step-number" aria-hidden="true">1</span><div><strong>Barangay verification</strong><p>Your assigned barangay reviews the relief request.</p></div></li>
              <li class="dsws-step"><span class="dsws-step-number" aria-hidden="true">2</span><div><strong>Donor visibility</strong><p>Donors can reserve support while your request is being verified. Fulfilment requires barangay approval.</p></div></li>
              <li class="dsws-step"><span class="dsws-step-number" aria-hidden="true">3</span><div><strong>Fulfilment tracking</strong><p>After approval, use Chat with barangay to coordinate pickup or delivery and follow your relief status.</p></div></li>`
            : `<li class="dsws-step"><span class="dsws-step-number" aria-hidden="true">1</span><div><strong>Account submitted</strong><p>Your household registration was received.</p></div></li>
              <li class="dsws-step"><span class="dsws-step-number" aria-hidden="true">2</span><div><strong>Barangay account review</strong><p>${escapeHtml(user.barangay)} verifies that your household belongs to the barangay.</p></div></li>
              <li class="dsws-step"><span class="dsws-step-number" aria-hidden="true">3</span><div><strong>Relief request access</strong><p>After approval, the Submit Request feature becomes available.</p></div></li>`}
        </ol></div>
      </section>
    </div></div>`;
    }
    return dashShell("HOUSEHOLD", tab, content);
}
function requestForm() {
    let s = session();
    return `<div class="dsws-overview">${dswsPageHeading("New relief request", "Request assistance", `Your request will go to ${s.barangay} for verification.`)}
    <section class="dsws-panel dsws-form-panel">${dswsPanelHeading("Assistance details", svg("plus"))}<div class="dsws-panel-body"><form class="form-grid" onsubmit="submitRequest(event)">
    <div class="form-row">
        <div class="field"><label for="reqHousehold">Household head</label><input id="reqHousehold" value="${escapeHtml(s.name)}" readonly></div>
      <div class="field"><label for="reqBarangay">Barangay</label><input id="reqBarangay" value="${escapeHtml(s.barangay)}" readonly></div>
    </div>
    <div class="form-row">
      <div class="field"><label for="reqContact">Contact number</label><input id="reqContact" required value="${escapeHtml(s.contact || "")}" placeholder="09XX XXX XXXX"></div>
      <div class="field"><label for="reqCategory">Assistance category</label><select id="reqCategory" required><option value="">Select category</option>${categoryOptions()}</select></div>
    </div>
    <div class="form-row">
      <div class="field"><label for="reqDisaster">Incident type</label><select id="reqDisaster" required><option value="">Select type</option><option>Typhoon</option><option>Flood</option><option>Fire</option><option>Landslide</option><option>Earthquake</option><option>Other</option></select></div>
        <div class="field"><label for="reqUrgency">Urgency</label><select id="reqUrgency"><option>Low</option><option>Medium</option><option>Urgent</option></select></div>
    </div>
    <div class="field"><label for="reqDescription">Description</label><textarea id="reqDescription" required placeholder="Describe what assistance your household needs."></textarea></div>
    <div class="field"><label for="reqPhotos">Photos</label><input id="reqPhotos" type="file" accept="image/*" multiple required><div class="helper">Attach 1 to 3 photos. Images are compressed before saving.</div></div>
    <div class="field request-location"><label for="reqLocation">Household location <span class="location-optional">(optional)</span></label>
      <div class="form-row location-controls"><input id="reqLocation" maxlength="500" placeholder="Address, landmark, or latitude, longitude" aria-describedby="reqLocationHelp reqLocationStatus" oninput="onRequestLocationInput(this)"><button id="reqLocationButton" class="btn btn-light" type="button" onclick="captureGps()">Use precise location</button></div>
      <div id="reqLocationHelp" class="helper">Tap once while at the household. We keep trying for an estimated accuracy of 10 metres or better, for up to a minute. Allow precise location if your device offers it.</div>
      <div class="location-feedback"><p id="reqLocationStatus" class="location-status" role="status" aria-live="polite" aria-atomic="true"></p><button id="reqLocationCancel" class="location-text-button" type="button" onclick="cancelGps()" hidden>Cancel</button></div>
      <div id="reqLocationResult" class="location-result" hidden></div>
    </div>
    <button class="btn btn-primary" type="submit">Submit for verification</button>
  </form></div></section></div>`;
}
const GPS_TARGET_ACCURACY_METERS = 10;
const GPS_CAPTURE_DEADLINE_MS = 60000;
const GPS_REACQUIRE_MS = 15000;
let locationCapture = null;
function parseGpsCoordinates(value) {
    if (typeof value !== "string" || !/^\s*[+-]?\d+(?:\.\d+)?\s*,\s*[+-]?\d+(?:\.\d+)?\s*$/.test(value)) return null;
    const [latitude, longitude] = value.split(",").map(Number);
    return Number.isFinite(latitude) && Math.abs(latitude) <= 90 && Number.isFinite(longitude) && Math.abs(longitude) <= 180
        ? { latitude, longitude } : null;
}
function gpsCoordinates(point) { return `${point.latitude.toFixed(6)}, ${point.longitude.toFixed(6)}`; }
function gpsMapUrl(point) {
    return `https://www.openstreetmap.org/?mlat=${point.latitude.toFixed(6)}&mlon=${point.longitude.toFixed(6)}#map=18/${point.latitude.toFixed(6)}/${point.longitude.toFixed(6)}`;
}
function gpsAccuracyLabel(accuracy) {
    return accuracy >= 1000 ? `${(accuracy / 1000).toFixed(1)} km` : `${Math.max(1, Math.ceil(accuracy))} m`;
}
function gpsSummary(point, accuracy) {
    const hasAccuracy = typeof accuracy === "number" && Number.isFinite(accuracy) && accuracy >= 0;
    return `<div class="location-pin-copy"><strong>${hasAccuracy ? "Device location" : "Map pin"}</strong><span class="location-coordinates">${gpsCoordinates(point)}</span>${hasAccuracy ? `<span class="location-accuracy">Estimated accuracy: within ${gpsAccuracyLabel(accuracy)}</span>` : ""}</div>
      <a class="location-map-link" href="${gpsMapUrl(point)}" target="_blank" rel="noopener noreferrer" aria-label="View pin on map (opens in a new tab)">View pin on map <span aria-hidden="true">↗</span></a>
      <p class="location-attribution">Map / address data © <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener noreferrer">OpenStreetMap contributors</a></p>`;
}
function setLocationStatus(field, message, tone = "") {
    const status = field.form?.querySelector("#reqLocationStatus");
    if (status) { status.textContent = message; status.dataset.tone = tone; }
}
function updateLocationResult(field) {
    const result = field.form?.querySelector("#reqLocationResult");
    if (!result) return;
    const point = parseGpsCoordinates(field.dataset.coordinates);
    result.hidden = !point;
    result.innerHTML = point ? gpsSummary(point, field.dataset.accuracy === undefined ? null : Number(field.dataset.accuracy)) : "";
}
function setLocationBusy(field, busy, label = "Finding precise location…") {
    const button = field.form?.querySelector("#reqLocationButton"), cancel = field.form?.querySelector("#reqLocationCancel");
    if (button) {
        button.disabled = busy;
        button.textContent = busy ? label : "Use precise location";
        button.setAttribute("aria-busy", String(busy));
    }
    if (cancel) cancel.hidden = !busy;
}
function stopLocationWatch(capture) {
    clearTimeout(capture.timer);
    clearTimeout(capture.retryTimer);
    capture.generation++;
    if (capture.watchId !== null) navigator.geolocation?.clearWatch(capture.watchId);
    capture.watchId = null;
}
function cancelLocationCapture() {
    const capture = locationCapture;
    if (!capture) return;
    locationCapture = null;
    stopLocationWatch(capture);
    capture.controller?.abort();
    setLocationBusy(capture.field, false);
}
window.cancelGps = () => {
    const field = locationCapture?.field;
    cancelLocationCapture();
    if (field?.isConnected) {
        setLocationStatus(field, field.dataset.coordinates ? "Stopped. The displayed pin has been kept; check it before submitting." : "Location detection cancelled. You can enter an address or try again.");
        field.form?.querySelector("#reqLocationButton")?.focus();
    }
};
window.onRequestLocationInput = field => {
    const hadPin = Boolean(field.dataset.coordinates);
    if (locationCapture?.field === field) cancelLocationCapture();
    delete field.dataset.coordinates;
    delete field.dataset.accuracy;
    delete field.dataset.capturedAt;
    const point = parseGpsCoordinates(field.value);
    if (point) field.dataset.coordinates = gpsCoordinates(point);
    updateLocationResult(field);
    setLocationStatus(field, point ? "Coordinates entered. Check the pin before submitting." : hadPin ? "Address edited; the previous pin was removed. Use precise location to add a new pin." : "");
};
window.captureGps = () => {
    const field = document.getElementById("reqLocation");
    if (!field || locationCapture) return;
    if (!window.isSecureContext) {
        setLocationStatus(field, "Location needs a secure connection. Open AYUDA over HTTPS, or use localhost on this computer. You can still enter an address.", "warning");
        return;
    }
    if (!navigator.geolocation) {
        setLocationStatus(field, "This browser does not support location. Enter an address or use a browser with location access.", "warning");
        return;
    }
    // A new attempt must not silently submit a pin from an earlier location.
    if (field.dataset.accuracy !== undefined) field.value = "";
    delete field.dataset.coordinates;
    delete field.dataset.accuracy;
    delete field.dataset.capturedAt;
    const manualPoint = parseGpsCoordinates(field.value);
    if (manualPoint) field.dataset.coordinates = gpsCoordinates(manualPoint);
    updateLocationResult(field);
    const capture = { field, watchId: null, timer: null, retryTimer: null, generation: 0, startedAt: Date.now(), best: null, accepted: false, controller: null, finishing: false };
    locationCapture = capture;
    const active = () => locationCapture === capture && field.isConnected;
    const finish = async error => {
        if (!active() || capture.finishing) return;
        capture.finishing = true;
        stopLocationWatch(capture);
        if (!capture.accepted) {
            const messages = {
                1: "Location access is blocked. Allow location in your browser's site settings and turn on device location services, then try again. No automatic pin was saved.",
                2: "Your device could not determine a location. Turn on location services and allow precise location if available. No automatic pin was saved.",
                3: "Location detection timed out without a precise reading. No automatic pin was saved. Try a phone with precise location enabled, or enter the household address."
            };
            cancelLocationCapture();
            const message = error?.code !== 1 && capture.best
                ? `Your device could only locate you within ${gpsAccuracyLabel(capture.best.accuracy)}; ${GPS_TARGET_ACCURACY_METERS} m or better is needed. No automatic pin was saved. Try a phone with precise location enabled, or enter the household address.`
                : messages[error?.code] || messages[2];
            setLocationStatus(field, message, "warning");
            return;
        }
        const point = capture.best;
        const guidance = `Location captured with an estimated accuracy of ${gpsAccuracyLabel(point.accuracy)}.`;
        setLocationBusy(field, true, "Looking up address…");
        setLocationStatus(field, `${guidance} Looking up a nearby address.`, "success");
        const controller = new AbortController();
        capture.controller = controller;
        const lookupTimer = setTimeout(() => controller.abort(), 8000);
        try {
            const response = await fetch("/api/location/reverse", {
                method: "POST", credentials: "same-origin",
                headers: await authHeaders(true),
                body: JSON.stringify({ latitude: point.latitude, longitude: point.longitude }), signal: controller.signal
            });
            if (!response.ok) throw new Error("Address lookup unavailable");
            const result = await response.json();
            if (!active()) return;
            const address = typeof result.address === "string" ? result.address.trim().slice(0, 500) : "";
            if (address) field.value = address;
            setLocationStatus(field, `${guidance} ${address ? "Nearby address added." : "No nearby address was found; the pin is ready to submit."}`, "success");
        }
        catch {
            if (active()) setLocationStatus(field, `${guidance} The address could not be loaded; your pin is ready to submit.`, "success");
        }
        finally {
            clearTimeout(lookupTimer);
            if (active()) { locationCapture = null; setLocationBusy(field, false); }
        }
    };
    setLocationBusy(field, true);
    setLocationStatus(field, `Finding precise location… Allow access when prompted. We will retry automatically for up to a minute until accuracy reaches ${GPS_TARGET_ACCURACY_METERS} m or better.`);
    capture.timer = setTimeout(() => finish({ code: 3 }), GPS_CAPTURE_DEADLINE_MS);
    const startWatch = () => {
        if (!active() || capture.finishing) return;
        clearTimeout(capture.retryTimer);
        if (capture.watchId !== null) navigator.geolocation.clearWatch(capture.watchId);
        capture.watchId = null;
        const generation = ++capture.generation;
        const current = () => active() && !capture.finishing && generation === capture.generation;
        // Reacquire while stationary too: a watch may otherwise stop reporting after a coarse fix.
        capture.retryTimer = setTimeout(startWatch, GPS_REACQUIRE_MS);
        const onError = error => {
            if (!current()) return;
            if (error.code === 1) { finish(error); return; }
            setLocationStatus(field, error.code === 3 ? "This reading timed out. Retrying automatically for a precise location…" : "Location is temporarily unavailable. Retrying automatically; keep device location services on.");
            clearTimeout(capture.retryTimer);
            capture.retryTimer = setTimeout(startWatch, 1000);
        };
        try {
            const watchId = navigator.geolocation.watchPosition(position => {
                if (!current()) return;
                const { latitude, longitude, accuracy } = position.coords || {};
                if (![latitude, longitude, accuracy, position.timestamp].every(Number.isFinite)
                    || Math.abs(latitude) > 90 || Math.abs(longitude) > 180 || accuracy <= 0
                    || position.timestamp < capture.startedAt - 1000 || position.timestamp > Date.now() + 1000) return;
                if (capture.best && capture.best.accuracy <= accuracy) return;
                capture.best = { latitude, longitude, accuracy };
                if (accuracy > GPS_TARGET_ACCURACY_METERS) {
                    setLocationStatus(field, `Improving location… Current estimate: within ${gpsAccuracyLabel(accuracy)}. Waiting for ${GPS_TARGET_ACCURACY_METERS} m or better; no pin has been saved yet.`);
                    return;
                }
                capture.accepted = true;
                // Only a sufficiently precise fix becomes a saved pin; address lookup is optional.
                field.value = gpsCoordinates(capture.best);
                field.dataset.coordinates = field.value;
                field.dataset.accuracy = String(accuracy);
                field.dataset.capturedAt = new Date(position.timestamp).toISOString();
                updateLocationResult(field);
                finish();
            }, onError, { enableHighAccuracy: true, maximumAge: 0, timeout: 15000 });
            // Synchronous or superseded callbacks must not leave an orphaned watch running.
            if (current()) capture.watchId = watchId;
            else navigator.geolocation.clearWatch(watchId);
        }
        catch { onError({ code: 2 }); }
    };
    startWatch();
};
function compressRequestPhoto(file) {
    return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => {
            const image = new Image();
            image.onload = () => {
                const scale = Math.min(1, 1200 / Math.max(image.naturalWidth, image.naturalHeight));
                const canvas = document.createElement("canvas");
                canvas.width = Math.max(1, Math.round(image.naturalWidth * scale));
                canvas.height = Math.max(1, Math.round(image.naturalHeight * scale));
                canvas.getContext("2d").drawImage(image, 0, 0, canvas.width, canvas.height);
                resolve(canvas.toDataURL("image/jpeg", .78));
            };
            image.onerror = () => reject(new Error("Invalid image"));
            image.src = reader.result;
        };
        reader.onerror = () => reject(new Error("Could not read image"));
        reader.readAsDataURL(file);
    });
}
window.submitRequest = async e => {
    e.preventDefault();
    const user = currentActor("HOUSEHOLD");
    if (!user) {
        toast("Your household account must be approved before submitting a request.");
        return;
    }
    if (locationCapture && !locationCapture.accepted) {
        toast("Still finding a precise location. Wait for a reading within 10 m, or cancel location detection to continue without an automatic pin.");
        return;
    }
    const requests = getRequests();
    const category = formValue("reqCategory"), contact = formValue("reqContact"), disaster = formValue("reqDisaster"), urgency = formValue("reqUrgency"), description = formValue("reqDescription"), locationField = document.getElementById("reqLocation"), location = formValue("reqLocation"), photoFiles = [...(document.getElementById("reqPhotos")?.files || [])];
    const point = parseGpsCoordinates(locationField?.dataset.coordinates) || parseGpsCoordinates(location);
    const coordinates = point ? gpsCoordinates(point) : "";
    const accuracy = locationField?.dataset.accuracy === undefined ? null : Number(locationField.dataset.accuracy);
    const gpsMetadata = point && Number.isFinite(accuracy) && accuracy >= 0 ? { gpsAccuracy: accuracy, gpsCapturedAt: locationField.dataset.capturedAt } : {};
    if (!BARANGAYS.includes(user.barangay) || !["Food", "Water", "Medical", "Shelter", "Utility"].includes(category) || !["Typhoon", "Flood", "Fire", "Landslide", "Earthquake", "Other"].includes(disaster) || !["Low", "Medium", "Urgent"].includes(urgency)) {
        toast("Select a valid barangay, category, incident type, and urgency.");
        return;
    }
    if (!contact || contact.length > 60 || !description || description.length > 2000) {
        toast("Enter a contact number and a description of up to 2,000 characters.");
        return;
    }
    if (location.length > 500) {
        toast("Keep the location to 500 characters or fewer.");
        return;
    }
    if (!photoFiles.length || photoFiles.length > 3 || photoFiles.some(file => !file.type.startsWith("image/"))) {
        toast("Attach 1 to 3 image files.");
        return;
    }
    const duplicate = requests.find(r => ownsRequest(user, r) && r.category === category && !["Fulfilled", "Rejected"].includes(r.status));
    if (duplicate) {
        toast(`You already have an active ${category} request.`);
        return;
    }
    if (locationCapture) {
        cancelLocationCapture();
        setLocationStatus(locationField, "The displayed pin is ready to submit.");
    }
    let photos = [];
    try {
        photos = await Promise.all(photoFiles.map(compressRequestPhoto));
    }
    catch {
        toast("One or more photos could not be processed.");
        return;
    }
    try {
        await api("/api/requests", {
            category,
            contact,
            disaster,
            urgency,
            description,
            location: location || "Not provided",
            gps: coordinates || "Not provided",
            ...gpsMetadata,
            photos
        });
        await refreshDashboardData(true);
    }
    catch (error) {
        toast(error.message);
        return;
    }
    toast("Request submitted.");
    goDash("HOUSEHOLD", "history");
};
function householdAccountsForBarangay(barangay, status = null) {
    return getUsers().filter(u => u.role === "HOUSEHOLD" && u.barangay === barangay && (!status || u.status === status));
}
function accountCards(accounts, actions = false) {
    if (!accounts.length)
        return `<div class="empty">No pending household accounts.</div>`;
    return `<div class="list">${accounts.map(account => `
    <div class="request-card">
      <div class="request-top">
        <div><strong>${escapeHtml(account.name)}</strong><div class="small muted" style="margin-top:3px">${escapeHtml(account.id)} • ${escapeHtml(account.barangay)}</div></div>
        ${accountBadge(account.status)}
      </div>
      <p>${escapeHtml(account.email)}${account.contact ? ` • ${escapeHtml(account.contact)}` : ""}</p>
      <div class="request-meta"><span>Registered ${formatDate(account.createdAt)}</span></div>
      <div class="actions">
        <button class="btn btn-light btn-sm" onclick="openAccount(${toInlineJsArg(account.id)})">View details</button>
        ${actions ? `<button class="btn btn-primary btn-sm" onclick="approveHouseholdAccount(${toInlineJsArg(account.id)})">Approve</button>
          <button class="btn btn-light btn-sm" onclick="rejectHouseholdAccount(${toInlineJsArg(account.id)})">Reject</button>` : ""}
      </div>
    </div>`).join("")}</div>`;
}
function accountVerificationPage(official, pendingAccounts) {
    const allAccounts = householdAccountsForBarangay(official.barangay);
    return `<div class="dsws-overview">${dswsPageHeading("Household verification", "Account Verification", `Approve or reject household accounts registered under ${official.barangay}. Only approved households can submit relief requests.`)}
    <div class="dsws-metrics">
      ${dswsMetric(pendingAccounts.length, "Pending accounts", dswsSymbol("clock"), "amber")}
      ${dswsMetric(allAccounts.filter(a => a.status === "APPROVED").length, "Approved accounts", svg("shield"), "green")}
      ${dswsMetric(allAccounts.filter(a => a.status === "REJECTED").length, "Rejected accounts", svg("close"), "purple")}
      ${dswsMetric(allAccounts.length, "Total households", svg("users"), "blue")}
    </div>
    <section class="dsws-panel">
      ${dswsPanelHeading("Pending Accounts", dswsSymbol("clock"), `<span class="small muted">${pendingAccounts.length} waiting</span>`)}
      <div class="dsws-panel-body">${accountCards(pendingAccounts, true)}</div>
    </section></div>`;
}
window.openAccount = id => {
    const actor = currentActor("DSWS_ADMIN") || currentActor("BARANGAY_OFFICIAL");
    const account = getUsers().find(u => u.id === id);
    if (!actor || !account || !(actor.role === "DSWS_ADMIN" || (actor.role === "BARANGAY_OFFICIAL" && account.role === "HOUSEHOLD" && account.barangay === actor.barangay))) {
        toast("You cannot view this account.");
        return;
    }
    showModal(`<div class="modal-head"><h2>${escapeHtml(account.name)}</h2><button class="icon-btn" aria-label="Close dialog" onclick="closeModal()">${svg("close")}</button></div>
    <div class="kv"><strong>Account ID</strong><span>${escapeHtml(account.id)}</span></div>
    <div class="kv"><strong>Status</strong><span>${accountBadge(account.status)}</span></div>
    <div class="kv"><strong>Barangay</strong><span>${escapeHtml(account.barangay || "—")}</span></div>
    <div class="kv"><strong>Email</strong><span>${escapeHtml(account.email)}</span></div>
    <div class="kv"><strong>Contact</strong><span>${escapeHtml(account.contact || "—")}</span></div>
    <div class="kv"><strong>Registered</strong><span>${formatDate(account.createdAt)}</span></div>
    ${account.rejectionReason ? `<div class="kv"><strong>Rejection reason</strong><span>${escapeHtml(account.rejectionReason)}</span></div>` : ""}`);
};
async function reviewAccount(id, action, reason = "") {
    if (accountActions.has(id))
        return;
    accountActions.add(id);
    try {
        const { user } = await api(`/api/accounts/${encodeURIComponent(id)}/${action}`, action === "reject" ? { reason } : {});
        cacheAccount(user);
        try { await refreshAuth(); }
        catch { /* The mutation response remains authoritative if a refresh fails. */ }
        toast(`${user.name}'s account was ${action === "approve" ? "approved" : "rejected"}.`);
        render();
    }
    catch (error) { toast(error.message); }
    finally { accountActions.delete(id); }
}
window.approveHouseholdAccount = async id => {
    const official = currentActor("BARANGAY_OFFICIAL");
    if (!official) {
        toast("An approved barangay official account is required.");
        return;
    }
    const users = getUsers();
    const account = users.find(u => u.id === id);
    if (!account || account.role !== "HOUSEHOLD" || account.status !== "PENDING" || account.barangay !== official.barangay) {
        toast("You cannot approve this account.");
        return;
    }
    await reviewAccount(id, "approve");
};
window.rejectHouseholdAccount = async id => {
    let official = currentActor("BARANGAY_OFFICIAL");
    if (!official) {
        toast("An approved barangay official account is required.");
        return;
    }
    let users = getUsers(), account = users.find(u => u.id === id);
    if (!account || account.role !== "HOUSEHOLD" || account.status !== "PENDING" || account.barangay !== official.barangay) {
        toast("You cannot reject this account.");
        return;
    }
    const reason = prompt("Reason for rejecting this household account (required):");
    if (!reason?.trim() || reason.trim().length > 2000) {
        toast("A rejection reason of up to 2,000 characters is required.");
        return;
    }
    official = currentActor("BARANGAY_OFFICIAL");
    users = getUsers();
    account = users.find(u => u.id === id);
    if (!official || !account || account.role !== "HOUSEHOLD" || account.status !== "PENDING" || account.barangay !== official.barangay) {
        toast("This account is no longer available for your review.");
        return;
    }
    await reviewAccount(id, "reject", reason.trim());
};
// -----------------------------------------------------------------------------
// Barangay portal
// -----------------------------------------------------------------------------
function barangayPage(tab = "overview") {
    if (!requireRole("BARANGAY_OFFICIAL"))
        return "";
    const official = session();
    const requests = getRequests().filter(r => r.barangay === official.barangay);
    const pendingRequests = requests.filter(r => r.status === "Under Verification");
    const escalated = pendingRequests.filter(r => hoursSince(r.createdAt) >= 72);
    const pendingAccounts = householdAccountsForBarangay(official.barangay, "PENDING");
    const allGeneralDonations = getDonations().filter(d => d.requestId === null && d.barangay === official.barangay);
    const pendingGeneralDonations = allGeneralDonations.filter(d => d.status === "Pending Approval");
    const reviewedGeneralDonations = allGeneralDonations.filter(d => d.status !== "Pending Approval");
    let content = "";
    if (tab === "accounts") {
        content = accountVerificationPage(official, pendingAccounts);
    }
    else if (tab === "pending") {
        content = `<div class="dsws-overview">${dswsPageHeading(official.barangay, "Pending relief requests", "Review relief requests assigned only to your barangay.")}
      ${escalated.length ? `<div class="alert warning"><strong>${escalated.length} request(s)</strong> have reached the 72-hour escalation threshold.</div>` : ""}
      <section class="dsws-panel">
        ${dswsPanelHeading("Pending general donations", svg("gift"), `<span class="small muted">${pendingGeneralDonations.length} waiting</span>`)}
        <div class="dsws-panel-body">${generalDonationList(pendingGeneralDonations)}</div>
      </section>
            <section class="dsws-panel">
                ${dswsPanelHeading("Reviewed donation conversations", svg("list"), `<span class="small muted">${reviewedGeneralDonations.length}</span>`)}
                <div class="dsws-panel-body">${generalDonationConversationList(reviewedGeneralDonations)}</div>
            </section>
      <section class="dsws-panel dsws-table-panel">${dswsPanelHeading("Pending relief requests", dswsSymbol("clock"))}${requestTable(pendingRequests, false, true)}</section></div>`;
    }
        else if (tab === "donations") {
                content = `<div class="dsws-overview">${dswsPageHeading(official.barangay, "General donations", "Review contributions for your barangay and continue donor conversations.")}
            <section class="dsws-panel">${dswsPanelHeading("Donation history", svg("gift"), "", allGeneralDonations.length)}<div class="dsws-panel-body">${generalDonationList(allGeneralDonations)}</div></section></div>`;
        }
    else if (tab === "all") {
        content = `<div class="dsws-overview">${dswsPageHeading(official.barangay, "Household requests", "Review requests and chat with approved households to coordinate relief.")}<section class="dsws-panel dsws-table-panel">${dswsPanelHeading("All requests", svg("list"))}${requestTable(requests, false, true)}</section></div>`;
    }
    else if (tab === "profile") {
        content = profilePanel(official);
    }
    else {
        content = `<div class="dsws-overview">${dswsPageHeading(official.barangay, "Barangay overview", "Verify household accounts, review relief requests, and confirm fulfilment.", `<button class="dsws-report-button" onclick="goDash('BARANGAY_OFFICIAL','accounts')">${svg("shield")}<span>Review accounts</span>${svg("arrow")}</button>`)}
    ${pendingAccounts.length ? `<div class="alert info"><strong>${pendingAccounts.length} household account(s)</strong> are waiting for barangay verification. <button class="btn btn-ghost btn-sm" onclick="goDash('BARANGAY_OFFICIAL','accounts')">Review now</button></div>` : ""}
    ${pendingGeneralDonations.length ? `<div class="alert info"><strong>${pendingGeneralDonations.length} general donation(s)</strong> are waiting for barangay approval. <button class="btn btn-ghost btn-sm" onclick="goDash('BARANGAY_OFFICIAL','pending')">Review now</button></div>` : ""}
    ${escalated.length ? `<div class="alert warning"><strong>Needs attention:</strong> ${escalated.length} relief request(s) have been pending 72 hours or more.</div>` : ""}
    <div class="dsws-metrics dsws-metrics-five">
      ${dswsMetric(pendingAccounts.length, "Pending accounts", svg("users"), "blue")}
      ${dswsMetric(pendingRequests.length, "Pending requests", dswsSymbol("clock"), "amber")}
      ${dswsMetric(pendingGeneralDonations.length, "Pending general donations", svg("gift"), "purple")}
      ${dswsMetric(requests.filter(r => r.status === "Approved").length, "Approved requests", svg("shield"), "blue")}
      ${dswsMetric(requests.filter(r => r.status === "Fulfilled").length, "Fulfilled", svg("check"), "green")}
    </div>
    <div class="dsws-panels dsws-panels-equal">
      <section class="dsws-panel">${dswsPanelHeading("Pending household accounts", svg("users"), `<button class="dsws-view-all" onclick="goDash('BARANGAY_OFFICIAL','accounts')">View all <span aria-hidden="true">&rsaquo;</span></button>`)}<div class="dsws-panel-body">${accountCards(pendingAccounts.slice(0, 4))}</div></section>
      <section class="dsws-panel">${dswsPanelHeading("Pending relief requests", dswsSymbol("clock"), `<button class="dsws-view-all" onclick="goDash('BARANGAY_OFFICIAL','pending')">View all <span aria-hidden="true">&rsaquo;</span></button>`)}<div class="dsws-panel-body">${requestList(pendingRequests.slice(0, 4), { actions: true })}</div></section>
        </div>
        <section class="dsws-panel">${dswsPanelHeading("Household relief conversations", svg("list"), `<button class="dsws-view-all" onclick="goDash('BARANGAY_OFFICIAL','all')">View all <span aria-hidden="true">&rsaquo;</span></button>`)}<div class="dsws-panel-body">${requests.some(r => canRequestChat(r)) ? requestList(requests.filter(r => canRequestChat(r)).slice(0, 3), { actions: true }) : '<div class="empty">Household conversations become available after request approval.</div>'}</div></section>
        <section class="dsws-panel">${dswsPanelHeading("Recent general donations", svg("gift"), `<button class="dsws-view-all" onclick="goDash('BARANGAY_OFFICIAL','donations')">View all <span aria-hidden="true">&rsaquo;</span></button>`, allGeneralDonations.length || null)}<div class="dsws-panel-body">${generalDonationList(allGeneralDonations.slice(0, 3))}</div></section></div>`;
    }
    return dashShell("BARANGAY_OFFICIAL", tab, content);
}
function barangayActions(r) {
    const hasDonorPledge = r.status === "Pledged" || getDonations().some(donation => donation.requestId === r.id);
    const donorChat = hasDonorPledge
        ? `<button class="btn btn-light btn-sm" type="button" onclick="openRequestDonorChat(${toInlineJsArg(r.id)})">Chat with donor</button>`
        : "";
    if (r.status === "Under Verification")
        return `<div class="actions"><button class="btn btn-primary btn-sm" onclick="approveRequest(${toInlineJsArg(r.id)})">Approve</button><button class="btn btn-light btn-sm" onclick="rejectRequest(${toInlineJsArg(r.id)})">Reject</button><button class="btn btn-light btn-sm" onclick="openRequest(${toInlineJsArg(r.id)})">Details</button>${donorChat}</div>`;
    if (r.status === "Pledged")
        return `<div class="actions"><button class="btn btn-primary btn-sm" onclick="markFulfilled(${toInlineJsArg(r.id)})">Mark fulfilled</button><button class="btn btn-light btn-sm" onclick="openRequest(${toInlineJsArg(r.id)})">Details</button>${requestChatButton(r)}${donorChat}</div>`;
    return `<div class="actions"><button class="btn btn-light btn-sm" onclick="openRequest(${toInlineJsArg(r.id)})">Details</button>${requestChatButton(r)}${donorChat}</div>`;
}
function reservationDeadline(d) {
    return d.expiresAt ? Date.parse(d.expiresAt) : Date.parse(d.createdAt) + 48 * 3600000;
}
function activeReservation(d, now = Date.now()) {
    return d.status === "Reserved" && reservationDeadline(d) > now;
}
window.approveRequest = async id => {
    const official = currentActor("BARANGAY_OFFICIAL");
    if (!official) {
        toast("An approved barangay official account is required.");
        return;
    }
    expirePledges();
    const requests = getRequests(), r = requests.find(x => x.id === id);
    if (!r || r.barangay !== official.barangay || r.status !== "Under Verification") {
        toast("This request is not available for your approval.");
        return;
    }
    const active = getDonations().some(d => d.requestId === id && activeReservation(d));
    try {
        const { request: updated } = await api(`/api/requests/${encodeURIComponent(id)}/approve`, {});
        await refreshDashboardData(true);
        toast(updated.status === "Pledged" || active ? "Request approved with active reserved support." : "Request approved.");
    }
    catch (error) {
        toast(error.message);
        return;
    }
    render();
};
window.rejectRequest = async id => {
    let official = currentActor("BARANGAY_OFFICIAL"), requests = getRequests(), r = requests.find(x => x.id === id);
    if (!official || !r || r.barangay !== official.barangay || r.status !== "Under Verification") {
        toast("This request is not available for your review.");
        return;
    }
    const reason = prompt("Reason for rejection (required):");
    if (!reason?.trim() || reason.trim().length > 2000) {
        toast("A rejection reason of up to 2,000 characters is required.");
        return;
    }
    try {
        await api(`/api/requests/${encodeURIComponent(id)}/reject`, { reason: reason.trim() });
        await refreshDashboardData(true);
    }
    catch (error) {
        toast(error.message);
        return;
    }
    toast("Request rejected and reserved donations cancelled.");
    render();
};
window.markFulfilled = async id => {
    const official = currentActor("BARANGAY_OFFICIAL");
    if (!official) {
        toast("An approved barangay official account is required.");
        return;
    }
    expirePledges();
    const requests = getRequests(), r = requests.find(x => x.id === id), donations = getDonations();
    if (!r || r.barangay !== official.barangay || r.status !== "Pledged") {
        toast("Only a pledged request in your barangay can be fulfilled.");
        return;
    }
    const active = donations.some(d => d.requestId === id && activeReservation(d));
    if (!active) {
        toast("This request has no active pledge to fulfil.");
        render();
        return;
    }
    try {
        await api(`/api/requests/${encodeURIComponent(id)}/fulfill`, {});
        await refreshDashboardData(true);
    }
    catch (error) {
        toast(error.message);
        return;
    }
    toast("Marked fulfilled.");
    render();
};
// -----------------------------------------------------------------------------
// Donor portal
// -----------------------------------------------------------------------------
function donorGroupValue(value) {
    return String(value ?? "").trim().replace(/\s+/g, " ").toLowerCase();
}
function donorUrgencyRank(value) {
    return ({ low: 1, normal: 2, medium: 2, high: 3, urgent: 4 })[donorGroupValue(value)] || 0;
}
function donorRequestTime(value) {
    const time = value ? Date.parse(value) : NaN;
    return Number.isFinite(time) ? time : Infinity;
}
function groupDonorRequests(records, { barangay = "", category = "" } = {}) {
    const groups = new Map(), b = donorGroupValue(barangay), c = donorGroupValue(category);
    for (const request of records) {
        if (!["Approved", "Under Verification"].includes(request.status)) continue;
        const requestBarangay = donorGroupValue(request.barangay), requestCategory = donorGroupValue(request.category);
        if ((b && requestBarangay !== b) || (c && requestCategory !== c)) continue;
        const key = JSON.stringify([requestBarangay, requestCategory]);
        if (!groups.has(key)) groups.set(key, {
            barangay: BARANGAYS.find(value => donorGroupValue(value) === requestBarangay) || request.barangay.trim(),
            category: ASSISTANCE_CATEGORIES.find(value => donorGroupValue(value) === requestCategory) || request.category.trim(),
            requests: []
        });
        groups.get(key).requests.push(request);
    }
    const result = [...groups.values()].map(group => {
        group.requests.sort((a, b) => donorUrgencyRank(b.urgency) - donorUrgencyRank(a.urgency)
            || donorRequestTime(a.createdAt) - donorRequestTime(b.createdAt) || a.id.localeCompare(b.id));
        const households = new Set(), disasters = new Map();
        let oldest = Infinity;
        group.unidentifiedCount = 0;
        group.approvedCount = 0;
        group.pendingCount = 0;
        group.oldestAt = null;
        for (const request of group.requests) {
            if (typeof request.householdId === "string" && request.householdId.trim()) households.add(request.householdId.trim());
            else group.unidentifiedCount++;
            if (request.status === "Approved") group.approvedCount++;
            else group.pendingCount++;
            const disaster = donorGroupValue(request.disaster);
            if (disaster && !disasters.has(disaster)) disasters.set(disaster, request.disaster.trim());
            const time = donorRequestTime(request.createdAt);
            if (time < oldest) { oldest = time; group.oldestAt = request.createdAt; }
        }
        group.householdCount = households.size;
        group.urgency = group.requests[0].urgency;
        group.disasters = [...disasters.values()].sort((a, b) => a.localeCompare(b));
        return group;
    });
    return result.sort((a, b) => donorUrgencyRank(b.urgency) - donorUrgencyRank(a.urgency)
        || donorRequestTime(a.oldestAt) - donorRequestTime(b.oldestAt)
        || a.barangay.localeCompare(b.barangay) || a.category.localeCompare(b.category));
}
function donorGroupCounts(group) {
    return `<div class="donor-group-counts"><span><strong>${group.householdCount}</strong> ${group.unidentifiedCount ? "identified " : ""}${group.householdCount === 1 ? "household" : "households"}</span><span><strong>${group.requests.length}</strong> ${group.requests.length === 1 ? "request" : "requests"}</span></div>
    ${group.unidentifiedCount ? `<p class="small muted">${group.unidentifiedCount} ${group.unidentifiedCount === 1 ? "request has" : "requests have"} no household identification and ${group.unidentifiedCount === 1 ? "is" : "are"} not included in the household count.</p>` : ""}`;
}
function donorGroupStatuses(group) {
    return `<div class="donor-group-statuses">${group.approvedCount ? `<span class="badge approved">${group.approvedCount} approved</span>` : ""}${group.pendingCount ? `<span class="badge pending">${group.pendingCount} under verification</span>` : ""}</div>`;
}
function donorGroupCards(groups, grid = false) {
    if (!groups.length) return `<div class="empty">No community requests match the selected filters.</div>`;
    return `<div class="${grid ? "donor-browse-grid" : "list"}">${groups.map(group => `<article class="request-card donor-request-card">
      <div class="request-top"><div><div class="small muted">${escapeHtml(group.barangay)}</div><h3>${escapeHtml(group.category)} assistance</h3></div><div class="donor-group-urgency"><span class="small muted">Highest urgency</span>${urgencyBadge(group.urgency)}</div></div>
      ${donorGroupCounts(group)}${donorGroupStatuses(group)}
      <div class="request-meta"><span>Incidents: ${escapeHtml(group.disasters.join(", ") || "Not specified")}</span><span>Oldest request: ${formatDate(group.oldestAt)}</span></div>
      <div class="actions"><button class="btn btn-primary btn-sm" type="button" onclick="openDonorGroup(${toInlineJsArg(group.barangay)},${toInlineJsArg(group.category)})">View requests</button></div>
    </article>`).join("")}</div>`;
}
function donorPage(tab = "overview") {
    if (!requireRole("DONOR"))
        return "";
    let s = session(), reqs = getRequests(), groups = groupDonorRequests(reqs), mine = getDonations().filter(d => d.donorId === s.id), content = "";
    if (tab === "browse")
        content = `<div class="dsws-overview">${dswsPageHeading("Community needs", "Browse requests", "Requests for the same assistance are grouped by barangay. Open a group to review household needs and pledge support, even while verification is pending.")}
    <section class="dsws-panel">${dswsPanelHeading("Find community needs", svg("search"))}<div class="filter-bar dashboard-filter-bar"><div class="field"><label for="filterBarangay">Barangay</label><select id="filterBarangay" onchange="renderBrowse()"><option value="">All barangays</option>${barangayOptions()}</select></div><div class="field"><label for="filterCategory">Category</label><select id="filterCategory" onchange="renderBrowse()"><option value="">All categories</option>${categoryOptions()}</select></div></div></section>
    <section class="dsws-panel" id="browseList" aria-live="polite">${browseList(reqs)}</section></div>`;
    else if (tab === "donations")
        content = `<div class="dsws-overview">${dswsPageHeading("Impact history", "My donations", "Track request support and general community contributions.", `<button class="dsws-report-button" onclick="openGeneralDonation()">${svg("gift")}<span>Make general donation</span><span class="dsws-chevron" aria-hidden="true">›</span></button>`)}<section class="dsws-panel dsws-table-panel">${dswsPanelHeading("Donation history", svg("gift"), "", mine.length)}${donationTable(mine)}</section></div>`;
    else if (tab === "profile")
        content = profilePanel(s);
    else
        content = `<div class="dsws-overview">${dswsPageHeading("Donor portal", "Support community needs.", "Donate immediately while barangay verification continues in parallel.", `<button class="dsws-report-button" onclick="goDash('DONOR','browse')">${svg("search")}<span>Browse requests</span><span class="dsws-chevron" aria-hidden="true">›</span></button>`)}
    <div class="dsws-metrics">${dswsMetric(groups.length, "Community needs", svg("list"), "blue")}${dswsMetric(mine.length, "My donations", svg("gift"), "purple")}${dswsMetric(mine.filter(d => d.status === "Reserved").length, "Active pledges", dswsSymbol("clock"), "amber")}${dswsMetric(mine.filter(d => d.status === "Completed").length, "Completed", svg("check"), "green")}</div>
    <div class="dsws-panels dsws-panels-equal">
      <section class="dsws-panel">${dswsPanelHeading("Priority community needs", svg("users"), `<button class="dsws-view-all" onclick="goDash('DONOR','browse')">Browse all<span aria-hidden="true">›</span></button>`)}<div class="dsws-panel-body">${donorGroupCards(groups.slice(0, 4))}</div></section>
      <section class="dsws-panel">${dswsPanelHeading("Give where it is needed most", svg("heart"))}<div class="dsws-panel-body donor-contribution"><span class="donor-contribution-icon" aria-hidden="true">${svg("heart")}</span><p>Make a general contribution even when no household request is available. DSWS can allocate it to urgent community needs.</p><button class="btn btn-primary" onclick="openGeneralDonation()">${svg("gift")}Donate generally</button><div class="alert info donor-pledge-note">Request-specific pledges expire 48 hours after they are created, including time spent waiting for barangay approval.</div></div></section>
    </div></div>`;
    setTimeout(() => { if (tab === "browse")
        renderBrowse(); }, 0);
    return dashShell("DONOR", tab, content);
}
function browseList(list, filters = {}) {
    const groups = groupDonorRequests(list, filters), total = groups.reduce((count, group) => count + group.requests.length, 0);
    return `${dswsPanelHeading("Community needs", svg("list"), "", groups.length)}<p class="small muted donor-browse-summary">${groups.length} ${groups.length === 1 ? "group" : "groups"} &bull; ${total} ${total === 1 ? "request" : "requests"}. Grouped by barangay and assistance category.</p>${donorGroupCards(groups, true)}`;
}
window.renderBrowse = () => {
    let b = document.getElementById("filterBarangay")?.value || "", c = document.getElementById("filterCategory")?.value || "";
    let el = document.getElementById("browseList");
    if (el)
        el.innerHTML = browseList(getRequests(), { barangay: b, category: c });
};
window.openDonorGroup = (barangay, category) => {
    if (!currentActor("DONOR")) {
        toast("An approved donor account is required.");
        return;
    }
    expirePledges();
    const group = groupDonorRequests(getRequests(), { barangay, category })[0];
    if (!group) {
        toast("These requests are no longer available.");
        renderBrowse();
        return;
    }
    showModal(`<div class="modal-head"><div><div class="modal-eyebrow">${escapeHtml(group.barangay)}</div><h2>${escapeHtml(group.category)} assistance</h2></div><button class="icon-btn" type="button" aria-label="Close dialog" onclick="closeModal()">${svg("close")}</button></div>
      ${donorGroupCounts(group)}${donorGroupStatuses(group)}
      <p class="small muted">Choose a household request to pledge support. Each pledge is tracked separately and reserved for 48 hours, including time awaiting barangay verification.</p>
      <div class="list">${group.requests.map(r => `<article class="request-card donor-group-member">
        <div class="request-top"><div><h3>${escapeHtml(r.household)}</h3><div class="small muted">${escapeHtml(r.id)}</div></div><div class="donor-group-statuses">${urgencyBadge(r.urgency)}${badge(r.status)}</div></div>
        <p>${escapeHtml(r.description)}</p><div class="request-meta"><span>${escapeHtml(r.disaster)}</span><span>${formatDate(r.createdAt)}</span></div>
        <div class="actions"><button class="btn btn-primary btn-sm" type="button" onclick="openDonorGroupMember(${toInlineJsArg(r.id)},'pledge')">Pledge support</button><button class="btn btn-light btn-sm" type="button" onclick="openDonorGroupMember(${toInlineJsArg(r.id)},'details')">Details</button></div>
      </article>`).join("")}</div>`);
    document.querySelector("#modalRoot .modal").classList.add("donor-group-dialog");
};
window.openDonorGroupMember = (id, action) => {
    if (!currentActor("DONOR") || !["pledge", "details"].includes(action)) return;
    const request = getRequests().find(r => r.id === id);
    if (!request) { toast("This request is no longer available."); return; }
    closeModal();
    if (action === "pledge") openPledge(id);
    else openRequest(id);
    const dialog = document.querySelector("#modalRoot .modal");
    if (!dialog) return;
    const back = document.createElement("button");
    back.type = "button";
    back.className = "btn btn-light btn-sm donor-group-back";
    back.textContent = "Back to grouped requests";
    back.addEventListener("click", () => openDonorGroup(request.barangay, request.category));
    if (action === "details") dialog.querySelector(".request-detail-body").prepend(back);
    else dialog.querySelector(".modal-head").after(back);
};
window.openPledge = id => {
    if (!currentActor("DONOR")) {
        toast("An approved donor account is required.");
        return;
    }
    expirePledges();
    const r = getRequests().find(x => x.id === id);
    if (!r || !["Approved", "Under Verification"].includes(r.status)) {
        toast("This request is no longer available.");
        return;
    }
    showModal(`<div class="modal-head"><h2>Pledge support</h2><button class="icon-btn" aria-label="Close dialog" onclick="closeModal()">${svg("close")}</button></div>
  <p class="small">${escapeHtml(r.id)} • ${escapeHtml(r.barangay)} • ${escapeHtml(r.category)}</p>
  <p class="small">Reserved for 48 hours from the time you pledge, including while verification is pending.</p>
  <form class="form-grid" onsubmit="submitPledge(event,${toInlineJsArg(id)})">
    <div class="field"><label for="pledgeType">Donation type</label><select id="pledgeType"><option>Items</option><option>Medical</option><option>Shelter</option><option>Other</option></select></div>
    <div class="field"><label for="pledgeAmount">Donation details / amount</label><input id="pledgeAmount" required maxlength="2000" placeholder="e.g. 10 food packs or 5 first-aid kits"></div>
    <button class="btn btn-primary">Confirm pledge</button>
  </form>`);
};
window.submitPledge = async (e, id) => {
    e.preventDefault();
    const donor = currentActor("DONOR");
    if (!donor) {
        toast("An approved donor account is required.");
        closeModal();
        return;
    }
    const type = formValue("pledgeType"), amount = formValue("pledgeAmount");
    if (!["Items", "Medical", "Shelter", "Other"].includes(type) || !amount || amount.length > 2000) {
        toast("Select a donation type and enter details of up to 2,000 characters.");
        return;
    }
    expirePledges();
    const requests = getRequests(), r = requests.find(x => x.id === id);
    if (!r || !["Approved", "Under Verification"].includes(r.status)) {
        toast("This request is no longer available.");
        closeModal();
        return;
    }
    if (getDonations().some(d => d.requestId === id && d.donorId === donor.id && activeReservation(d))) {
        toast("You already have an active pledge for this request.");
        return;
    }
    try {
        await api("/api/donations", { requestId: id, type, amount });
        await refreshDashboardData(true);
    }
    catch (error) {
        toast(error.message);
        return;
    }
    closeModal();
    toast(r.status === "Under Verification" ? "Pledge reserved for 48 hours while awaiting barangay verification." : "Pledge reserved for 48 hours.");
    render();
};
window.openGeneralDonation = () => {
    if (!currentActor("DONOR")) {
        toast("An approved donor account is required.");
        return;
    }
    showModal(`<div class="modal-head"><h2>Make a general donation</h2><button class="icon-btn" aria-label="Close dialog" onclick="closeModal()">${svg("close")}</button></div>
  <p>Support AYUDA CEBU even when no household request is available. Select the barangay that should receive the donation for review and approval.</p>
  <form class="form-grid" onsubmit="submitGeneralDonation(event)">
    <div class="field"><label for="generalDonationType">Donation type</label><select id="generalDonationType"><option>Items</option><option>Water</option><option>Food</option><option>Medical</option><option>Shelter</option><option>Other</option></select></div>
    <div class="field"><label for="generalDonationBarangay">Barangay</label><select id="generalDonationBarangay" required><option value="">Select barangay</option>${barangayOptions()}</select></div>
    <div class="field"><label for="generalDonationAmount">Donation details / amount</label><input id="generalDonationAmount" required maxlength="2000" placeholder="e.g. 20 water containers or 5 first-aid kits"></div>
    <button class="btn btn-primary">Confirm donation</button>
  </form>`);
};
window.submitGeneralDonation = async e => {
    e.preventDefault();
    const donor = currentActor("DONOR");
    if (!donor) {
        toast("An approved donor account is required.");
        closeModal();
        return;
    }
    const type = formValue("generalDonationType"), amount = formValue("generalDonationAmount"), barangay = formValue("generalDonationBarangay");
    if (!["Items", "Water", "Food", "Medical", "Shelter", "Other"].includes(type) || !amount || amount.length > 2000) {
        toast("Select a donation type and enter details of up to 2,000 characters.");
        return;
    }
    if (!BARANGAYS.includes(barangay)) {
        toast("Select a valid barangay for the donation review.");
        return;
    }
    try {
        await api("/api/donations", { type, amount, barangay });
        await refreshDashboardData(true);
    }
    catch (error) {
        toast(error.message);
        return;
    }
    closeModal();
    toast("General donation submitted for barangay review. Thank you for supporting the community.");
    render();
};
window.approveGeneralDonation = async id => {
    const official = currentActor("BARANGAY_OFFICIAL");
    if (!official) {
        toast("An approved barangay official account is required.");
        return;
    }
    const donation = getDonations().find(d => d.id === id);
    if (!donation || donation.requestId !== null || donation.barangay !== official.barangay || donation.status !== 'Pending Approval') {
        toast("This donation is not available for your review.");
        return;
    }
    try {
        await api(`/api/donations/${encodeURIComponent(id)}/approve`, {});
        await refreshDashboardData(true);
    }
    catch (error) {
        toast(error.message);
        return;
    }
    toast("General donation approved.");
    render();
};
window.rejectGeneralDonation = async id => {
    const official = currentActor("BARANGAY_OFFICIAL");
    if (!official) {
        toast("An approved barangay official account is required.");
        return;
    }
    const donations = getDonations();
    const donation = donations.find(d => d.id === id);
    if (!donation || donation.requestId !== null || donation.barangay !== official.barangay || donation.status !== 'Pending Approval') {
        toast("This donation is not available for your review.");
        return;
    }
    const reason = prompt("Reason for rejecting this general donation (required):");
    if (!reason?.trim() || reason.trim().length > 2000) {
        toast("A rejection reason of up to 2,000 characters is required.");
        return;
    }
    try {
        await api(`/api/donations/${encodeURIComponent(id)}/reject`, { reason: reason.trim() });
        await refreshDashboardData(true);
    }
    catch (error) {
        toast(error.message);
        return;
    }
    toast("General donation rejected.");
    render();
};
// -----------------------------------------------------------------------------
// DSWS administration
// -----------------------------------------------------------------------------
function officialAccounts(status = null) {
    return getUsers().filter(u => u.role === "BARANGAY_OFFICIAL" && (!status || u.status === status));
}
function dswsSymbol(name) {
    const paths = {
        clock: '<circle cx="12" cy="12" r="9"/><path d="M12 6v6l4 3"/>',
        food: '<path d="M4 3v7a3 3 0 0 0 6 0V3M7 3v18M17 21V3c-4 2-5 6-5 10h5"/>',
        water: '<path d="M12 2C9 7 5 10 5 14a7 7 0 0 0 14 0c0-4-4-7-7-12Z"/>',
        medical: '<path d="M12 3v18M3 12h18"/>',
        shelter: '<path d="m3 11 9-8 9 8M5 10v11h14V10M10 21v-7h4v7"/>',
        utility: '<path d="m13 2-9 11h7l-1 9 10-12h-7l1-8Z"/>',
        bell: '<path d="M18 8a6 6 0 0 0-12 0c0 7-3 8-3 10h18c0-2-3-3-3-10ZM10 21h4"/>'
    };
    return `<svg viewBox="0 0 24 24" width="24" height="24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${paths[name] || paths.bell}</svg>`;
}
function dswsMetric(value, label, icon, tone) {
    return `<div class="dsws-metric dsws-${tone}"><span class="dsws-metric-icon" aria-hidden="true">${icon}</span><span class="dsws-metric-dot" aria-hidden="true"></span><div class="dsws-metric-copy"><strong>${escapeHtml(value)}</strong><span>${escapeHtml(label)}</span></div></div>`;
}
function dswsPageHeading(eyebrow, title, description, action = "") {
    return `<div class="dsws-hero"><div class="dsws-hero-copy"><div class="dsws-eyebrow"><span aria-hidden="true"></span>${escapeHtml(eyebrow)}</div><h1>${escapeHtml(title)}</h1><p>${escapeHtml(description)}</p></div>${action}</div>`;
}
function dswsPanelHeading(title, icon, aside = "", count = null) {
    return `<div class="dsws-panel-head"><div><span class="dsws-panel-icon" aria-hidden="true">${icon}</span><h2>${escapeHtml(title)}</h2>${count !== null ? `<span class="dsws-count">${escapeHtml(count)}</span>` : ""}</div>${aside}</div>`;
}
function dswsUnmetNeeds(reqs) {
    const icons = { Food: "food", Water: "water", Medical: "medical", Shelter: "shelter", Utility: "utility" };
    const needs = ASSISTANCE_CATEGORIES.map(category => ({ category, count: reqs.filter(r => r.category === category && !["Fulfilled", "Rejected"].includes(r.status)).length }));
    const max = Math.max(1, ...needs.map(item => item.count));
    return needs.map(({ category, count }) => `<div class="dsws-need"><span class="dsws-need-icon">${dswsSymbol(icons[category])}</span><div class="dsws-need-body"><div class="dsws-need-label"><span>${escapeHtml(category)}</span><strong>${count}</strong></div><div class="dsws-need-track" role="meter" aria-label="${escapeHtml(category)} unmet needs" aria-valuemin="0" aria-valuemax="${max}" aria-valuenow="${count}"><span style="width:${count / max * 100}%"></span></div></div></div>`).join("");
}
function dswsEscalated(esc) {
    if (!esc.length) return `<div class="dsws-empty"><svg viewBox="0 0 180 130" width="180" height="130" fill="none" aria-hidden="true"><circle cx="89" cy="63" r="61" fill="#F2F7FF"/><rect x="43" y="40" width="75" height="75" rx="7" transform="rotate(-12 43 40)" fill="#A9D1FF"/><rect x="57" y="28" width="75" height="91" rx="7" fill="white" stroke="#B6D3FF"/><path d="M73 47h42M73 61h31M73 75h23" stroke="#9DC7FF" stroke-width="4" stroke-linecap="round"/><circle cx="131" cy="85" r="21" fill="white" stroke="#438BE8" stroke-width="5"/><path d="m146 101 18 17" stroke="#438BE8" stroke-width="6" stroke-linecap="round"/></svg><strong>No requests to show.</strong><p>Great! There are currently no escalated requests<br class="dsws-wide-only"> that need attention.</p></div>`;
    return `<div class="dsws-escalated-list">${requestList(esc.slice(0, 5), {})}</div>`;
}
function officialCards(accounts, actions = false) {
    if (!accounts.length)
        return `<div class="empty">No Barangay Official accounts found.</div>`;
    return `<div class="list">${accounts.map(account => `
    <div class="request-card"><div class="request-top"><div><strong>${escapeHtml(account.name)}</strong><div class="small muted">${escapeHtml(account.id)} • ${escapeHtml(account.barangay)}</div></div>${accountBadge(account.status)}</div>
      <p>${escapeHtml(account.email)} • ${escapeHtml(account.contact || "No contact")}</p><div class="request-meta"><span>Registered ${formatDate(account.createdAt)}</span></div>
      ${actions ? `<div class="actions"><button class="btn btn-primary btn-sm" onclick="approveOfficial(${toInlineJsArg(account.id)})">Approve</button><button class="btn btn-light btn-sm" onclick="rejectOfficial(${toInlineJsArg(account.id)})">Reject</button></div>` : ""}
    </div>`).join("")}</div>`;
}
function officialsPage() {
    const pending = officialAccounts("PENDING"), approved = officialAccounts("APPROVED");
    return `<div class="dsws-overview">${dswsPageHeading("DSWS authorization", "Barangay Officials", "Approve official registrations or create the first approved official for a barangay.")}
    <div class="dsws-metrics dsws-metrics-three">${dswsMetric(pending.length, "Pending approval", dswsSymbol("clock"), "amber")}${dswsMetric(approved.length, "Approved officials", svg("shield"), "green")}${dswsMetric(new Set(approved.map(u => u.barangay)).size, "Barangays covered", svg("building"), "blue")}</div>
    <div class="dsws-panels dsws-panels-equal"><section class="dsws-panel">${dswsPanelHeading("Create approved official", svg("plus"))}<div class="dsws-panel-body">
      <form class="form-grid" onsubmit="createOfficial(event)"><div class="field"><label for="officialName">Full name</label><input id="officialName" required placeholder="Barangay officer name"></div><div class="field"><label for="officialBarangay">Barangay</label><select id="officialBarangay" required><option value="">Select barangay</option>${barangayOptions()}</select></div><div class="field"><label for="officialContact">Contact number</label><input id="officialContact" required placeholder="09XX XXX XXXX"></div><div class="field"><label for="officialEmail">Email</label><input id="officialEmail" type="email" required placeholder="official@example.com"></div><div class="field"><label for="officialPassword">Temporary password</label><input id="officialPassword" type="password" minlength="8" required placeholder="At least 8 characters"></div><button class="btn btn-primary" type="submit">Create official account</button></form>
    </div></section><section class="dsws-panel">${dswsPanelHeading("Pending registrations", dswsSymbol("clock"), "", pending.length)}<div class="dsws-panel-body">${officialCards(pending, true)}</div></section></div>
    <section class="dsws-panel">${dswsPanelHeading("Approved officials", svg("shield"), "", approved.length)}<div class="dsws-panel-body">${officialCards(approved)}</div></section></div>`;
}
window.createOfficial = e => submitForm(e, "Creating official…", async () => {
    const admin = currentActor("DSWS_ADMIN");
    if (!admin) {
        toast("An approved DSWS administrator account is required.");
        return;
    }
    const email = formValue("officialEmail").toLowerCase(), password = formValue("officialPassword", false), name = formValue("officialName"), barangay = formValue("officialBarangay"), contact = formValue("officialContact");
    if (!name || name.length > 160 || !validEmail(email) || password.trim().length < 8 || !BARANGAYS.includes(barangay) || !contact || contact.length > 60) {
        toast("Enter a name, barangay, contact, valid email, and password of at least 8 characters.");
        return;
    }
    const { user } = await api("/api/accounts/officials", { name, email, password, barangay, contact });
    cacheAccount(user);
    e.target.reset();
    try { await refreshAuth(); }
    catch { /* Keep the newly created account returned by the server. */ }
    toast("Approved Barangay Official account created.");
    render();
});
window.approveOfficial = async id => {
    const admin = currentActor("DSWS_ADMIN");
    if (!admin) {
        toast("An approved DSWS administrator account is required.");
        return;
    }
    const users = getUsers(), account = users.find(u => u.id === id && u.role === "BARANGAY_OFFICIAL" && u.status === "PENDING");
    if (!account) {
        toast("This official account is no longer pending review.");
        return;
    }
    await reviewAccount(id, "approve");
};
window.rejectOfficial = async id => {
    let admin = currentActor("DSWS_ADMIN"), users = getUsers(), account = users.find(u => u.id === id && u.role === "BARANGAY_OFFICIAL" && u.status === "PENDING");
    if (!admin || !account) {
        toast("This official account is not available for your review.");
        return;
    }
    const reason = prompt("Reason for rejecting this official account (required):");
    if (!reason?.trim() || reason.trim().length > 2000) {
        toast("A rejection reason of up to 2,000 characters is required.");
        return;
    }
    admin = currentActor("DSWS_ADMIN");
    users = getUsers();
    account = users.find(u => u.id === id && u.role === "BARANGAY_OFFICIAL" && u.status === "PENDING");
    if (!admin || !account) {
        toast("This official account is no longer available for your review.");
        return;
    }
    await reviewAccount(id, "reject", reason.trim());
};
function dswsPage(tab = "overview") {
    if (!requireRole("DSWS_ADMIN"))
        return "";
    let reqs = getRequests(), dons = getDonations(), pending = reqs.filter(r => r.status === "Under Verification"), esc = pending.filter(r => hoursSince(r.createdAt) >= 72), fulfilled = reqs.filter(r => r.status === "Fulfilled").length, rate = reqs.length ? Math.round(fulfilled / reqs.length * 100) : 0, content = "";
    if (tab === "officials") {
        content = officialsPage();
    }
    else if (tab === "profile") {
        content = profilePanel(session());
    }
    else if (tab === "barangays") {
        let counts = {};
        BARANGAYS.forEach(b => counts[b] = 0);
        reqs.forEach(r => counts[r.barangay] = (counts[r.barangay] || 0) + 1);
        let top = Object.entries(counts).sort((a, b) => b[1] - a[1]).slice(0, 10), max = Math.max(...top.map(x => x[1]), 1);
        const activeBarangays = BARANGAYS.filter(b => counts[b] > 0).length;
        const coveredBarangays = new Set(officialAccounts("APPROVED").map(u => u.barangay).filter(b => BARANGAYS.includes(b))).size;
        content = `<div class="dsws-overview">${dswsPageHeading("Citywide view", "Barangay monitoring", `Relief request activity across all ${BARANGAYS.length} Cebu City barangays.`)}
      <div class="dsws-metrics">${dswsMetric(BARANGAYS.length, "Barangays monitored", svg("building"), "blue")}${dswsMetric(activeBarangays, "Barangays with requests", svg("map"), "purple")}${dswsMetric(coveredBarangays, "Barangays with officials", svg("shield"), "green")}${dswsMetric(pending.length, "Pending verification", dswsSymbol("clock"), "amber")}</div>
      <div class="dsws-panels dsws-panels-equal">
        <section class="dsws-panel">${dswsPanelHeading("Requests by barangay", svg("chart"))}<div class="dsws-panel-body"><p class="small muted">Top 10 barangays by submitted requests.</p>${top.map(([b, n]) => `<div class="progress-row"><div class="progress-label"><span>${escapeHtml(b)}</span><strong>${n}</strong></div><div class="progress" role="meter" aria-label="${escapeHtml(b)} requests" aria-valuemin="0" aria-valuemax="${max}" aria-valuenow="${n}"><span style="width:${n / max * 100}%"></span></div></div>`).join("")}</div></section>
        <section class="dsws-panel">${dswsPanelHeading("Citywide coverage", svg("map"))}<div class="dsws-panel-body"><p class="small muted">Request activity and approved official coverage across Cebu City.</p><div class="kv"><strong>Registered barangays</strong><span>${BARANGAYS.length}</span></div><div class="kv"><strong>Barangays with requests</strong><span>${activeBarangays}</span></div><div class="kv"><strong>Barangays with approved officials</strong><span>${coveredBarangays}</span></div><div class="kv"><strong>Barangays without approved officials</strong><span>${BARANGAYS.length - coveredBarangays}</span></div><div class="kv"><strong>Total requests</strong><span>${reqs.length}</span></div></div></section>
      </div></div>`;
    }
    else if (tab === "requests") {
        content = `<div class="dsws-overview">${dswsPageHeading("Administrative review", "Citywide requests", "Monitor verification delays, status, and barangay-level activity.")}
      <div class="dsws-metrics">${dswsMetric(reqs.length, "Total requests filed", svg("report"), "blue")}${dswsMetric(pending.length, "Pending verification", dswsSymbol("clock"), "amber")}${dswsMetric(fulfilled, "Fulfilled requests", svg("check"), "green")}${dswsMetric(esc.length, "Escalated requests", dswsSymbol("bell"), "purple")}</div>
      ${esc.length ? `<div class="alert warning"><strong>${esc.length} escalated request(s)</strong> have remained unverified for at least 72 hours.</div>` : ""}<section class="dsws-panel dsws-table-panel">${dswsPanelHeading("All requests", svg("list"), "", reqs.length)}${requestTable(reqs, false, false, true)}</section></div>`;
    }
    else if (tab === "reports") {
        content = `<div class="dsws-overview">${dswsPageHeading("Official reporting", "DSWS reports", "Download an A4 PDF with request and donation totals, unmet needs, and a barangay breakdown.", `<button class="dsws-report-button" id="exportSummaryButton" onclick="exportReport()">${svg("report")}<span>Export summary (PDF)</span>${svg("arrow")}</button>`)}
      <div class="dsws-metrics">${dswsMetric(reqs.length, "Total requests filed", svg("report"), "blue")}${dswsMetric(rate + "%", "Fulfilment rate", svg("check"), "green")}${dswsMetric(esc.length, "Escalated requests", dswsSymbol("bell"), "amber")}${dswsMetric(dons.filter(d => d.status === "Reserved").length, "Active contributions", svg("users"), "purple")}</div>
      <div class="dsws-panels dsws-panels-equal">
        <section class="dsws-panel">${dswsPanelHeading("Current summary", svg("chart"))}<div class="dsws-panel-body"><div class="kv"><strong>Total requests</strong><span>${reqs.length}</span></div><div class="kv"><strong>Fulfilled</strong><span>${fulfilled}</span></div><div class="kv"><strong>Fulfilment rate</strong><span>${rate}%</span></div><div class="kv"><strong>Active donations</strong><span>${dons.filter(d => d.status === "Reserved").length}</span></div><div class="kv"><strong>Escalated</strong><span>${esc.length}</span></div></div></section>
        <section class="dsws-panel">${dswsPanelHeading("Unmet needs", svg("heart"))}<div class="dsws-needs">${dswsUnmetNeeds(reqs)}</div></section>
      </div></div>`;
    }
    else {
        content = `<div class="dsws-overview">${dswsPageHeading("Department of Social Welfare and Services", "Citywide relief overview", "Monitor verification, unmet needs, donor activity, and fulfilment across Cebu City.", `<button class="dsws-report-button" onclick="goDash('DSWS_ADMIN','reports')">${svg("chart")}<span>View reports</span><span class="dsws-chevron" aria-hidden="true">›</span></button>`)}
      <div class="dsws-metrics">${dswsMetric(reqs.length, "Total requests filed", svg("report"), "blue")}${dswsMetric(rate + "%", "Fulfilment rate", svg("check"), "green")}${dswsMetric(pending.length, "Pending verification", dswsSymbol("clock"), "amber")}${dswsMetric(dons.filter(d => d.status === "Reserved").length, "Active contributions", svg("users"), "purple")}</div>
      <div class="dsws-panels"><section class="dsws-panel">${dswsPanelHeading("Escalated requests", dswsSymbol("bell"), `<button class="dsws-view-all" onclick="goDash('DSWS_ADMIN','requests')">View all <span aria-hidden="true">›</span></button>`, esc.length || null)}${dswsEscalated(esc)}</section><section class="dsws-panel">${dswsPanelHeading("Unmet needs", svg("heart"))}<div class="dsws-needs">${dswsUnmetNeeds(reqs)}</div></section></div></div>`;
    }
    return dashShell("DSWS_ADMIN", tab, content);
}
let reportLibrariesLoading;
let reportExporting = false;
let preparedReport = null;
function loadReportLibraries() {
    if (!reportLibrariesLoading) {
        const loadError = "PDF files could not be loaded from the app server. Restart the app server, then refresh this page and try again.";
        const load = src => new Promise((resolve, reject) => {
            const script = document.createElement("script");
            script.src = src;
            script.onload = resolve;
            script.onerror = () => { script.remove(); reject(new Error(loadError)); };
            document.head.appendChild(script);
        });
        reportLibrariesLoading = (async () => {
            if (typeof window.jspdf?.jsPDF !== "function") await load("/vendor/jspdf.umd.min.js");
            if (typeof window.jspdf?.jsPDF !== "function") throw new Error(loadError);
            if (typeof window.jspdf.jsPDF.API?.autoTable !== "function") await load("/vendor/jspdf.plugin.autotable.min.js");
            if (typeof window.jspdf.jsPDF.API?.autoTable !== "function") throw new Error(loadError);
        })().catch(error => { reportLibrariesLoading = null; throw error; });
    }
    return reportLibrariesLoading;
}
function reportUsesTouchControls() {
    return navigator.maxTouchPoints > 0 || window.matchMedia("(pointer: coarse)").matches;
}
function buildReportInWorker(summary) {
    return new Promise((resolve, reject) => {
        let worker;
        let timer;
        const finish = (error, buffer) => {
            clearTimeout(timer);
            worker?.terminate();
            error ? reject(error) : resolve(new Blob([buffer], { type: "application/pdf" }));
        };
        try {
            worker = new Worker("/report-worker.js");
            timer = setTimeout(() => finish(new Error("Preparing the PDF took too long. Please try again.")), 60000);
            worker.onmessage = ({ data }) => {
                if (!(data?.buffer instanceof ArrayBuffer)) {
                    finish(new Error(data?.error || "Could not prepare the PDF. Please try again."));
                    return;
                }
                finish(null, data.buffer);
            };
            worker.onerror = event => {
                event.preventDefault();
                finish(new Error("PDF files could not be loaded. Restart the app server, refresh this page, and try again."));
            };
            worker.postMessage(summary);
        }
        catch (error) { finish(error); }
    });
}
function showReportDownload(blob, filename) {
    const report = { url: URL.createObjectURL(blob), file: new File([blob], filename, { type: "application/pdf" }) };
    let canShare = false;
    try { canShare = typeof navigator.share === "function" && navigator.canShare?.({ files: [report.file] }); }
    catch { /* Download and preview remain available when file sharing is unsupported. */ }
    showModal(`<div class="report-download-dialog" id="reportDownloadDialog">
        <div class="modal-head"><div><div class="modal-eyebrow">Report export</div><h2>Your PDF is ready</h2></div><button class="icon-btn modal-close" aria-label="Close report download" onclick="closeModal()">${svg("close")}</button></div>
        <div class="report-download-file">${svg("report")}<div><strong>DSWS Relief Summary</strong><span>${escapeHtml(filename)}</span><span>PDF &middot; ${Math.max(1, Math.ceil(blob.size / 1024))} KB</span></div></div>
        <p>Tap <strong>Download PDF</strong> to save your report. If it opens as a preview, use your browser's Share or Save option.</p>
        <div class="report-download-actions"><a class="btn btn-primary" id="downloadReportPdf" download target="_blank" rel="noopener">Download PDF</a>${canShare ? '<button class="btn btn-light" id="shareReportPdf" onclick="shareReportPdf()">Share / Save</button>' : ""}<a class="btn btn-light" id="openReportPdf" target="_blank" rel="noopener">Open PDF</a></div>
        <p class="small muted">On iPhone, you can save the PDF to Files from the share menu.</p>
    </div>`, () => {
        if (preparedReport === report) preparedReport = null;
        // A preview tab or the browser's download manager may still be reading the URL.
        setTimeout(() => URL.revokeObjectURL(report.url), 60000);
    });
    preparedReport = report;
    const download = document.getElementById("downloadReportPdf");
    download.href = report.url;
    download.download = filename;
    document.getElementById("openReportPdf").href = report.url;
}
window.shareReportPdf = async () => {
    if (!currentActor("DSWS_ADMIN") || !preparedReport) return;
    const button = document.getElementById("shareReportPdf");
    if (button?.disabled) return;
    if (button) button.disabled = true;
    try {
        // Start sharing directly inside this tap; do not await loading or generation first.
        await navigator.share({ files: [preparedReport.file], title: "DSWS Relief Summary" });
    }
    catch (error) {
        if (error.name !== "AbortError") toast("Sharing is unavailable. Try Download PDF or Open PDF.");
    }
    finally { if (button) button.disabled = false; }
};
window.exportReport = async () => {
    if (!currentActor("DSWS_ADMIN")) {
        toast("An approved DSWS administrator account is required.");
        return;
    }
    if (reportExporting) return;
    reportExporting = true;
    const button = document.getElementById("exportSummaryButton");
    if (button) { button.disabled = true; button.setAttribute("aria-busy", "true"); button.querySelector("span").textContent = "Preparing PDF..."; }
    try {
        if (typeof window.DswsReport?.buildSummary !== "function" || typeof window.DswsReport?.createPdf !== "function") {
            throw new Error("The PDF report module could not be loaded. Restart the app server, then refresh this page and try again.");
        }
        // Paint the busy state before reading records or preparing the PDF.
        await new Promise(resolve => requestAnimationFrame(() => setTimeout(resolve, 0)));
        if (!currentActor("DSWS_ADMIN")) throw new Error("An approved DSWS administrator account is required.");
        expirePledges();
        const summary = DswsReport.buildSummary({ requests: getRequests(), donations: getDonations(), barangays: BARANGAYS, categories: ASSISTANCE_CATEGORIES });
        if (reportUsesTouchControls()) {
            let blob;
            if (typeof Worker === "function") blob = await buildReportInWorker(summary);
            else {
                await loadReportLibraries();
                blob = DswsReport.createPdf(summary, window.jspdf.jsPDF).output("blob");
            }
            if (!currentActor("DSWS_ADMIN")) throw new Error("An approved DSWS administrator account is required.");
            // A fresh tap on a ready file avoids mobile download/popup gesture restrictions.
            showReportDownload(blob, summary.filename);
        } else {
            await loadReportLibraries();
            if (!currentActor("DSWS_ADMIN")) throw new Error("An approved DSWS administrator account is required.");
            const doc = DswsReport.createPdf(summary, window.jspdf.jsPDF);
            await doc.save(summary.filename, { returnPromise: true });
            toast("PDF summary download started.");
        }
    }
    catch (error) {
        toast(error.message || "Could not generate the PDF. Please try again.");
    }
    finally {
        reportExporting = false;
        if (button) { button.disabled = false; button.removeAttribute("aria-busy"); button.querySelector("span").textContent = "Export summary (PDF)"; }
    }
};
// -----------------------------------------------------------------------------
// Shared dashboard views
// -----------------------------------------------------------------------------
function profilePanel(user) {
    return `<div class="dsws-overview">${dswsPageHeading("Account", "Profile", "Account information and verification status.")}
    ${user.role === "HOUSEHOLD" ? accountStatusPanel(user) : ""}
    <section class="dsws-panel dashboard-profile-panel">
      ${dswsPanelHeading("Account details", svg("users"))}
      <div class="dsws-panel-body">
      <div class="kv"><strong>Name</strong><span>${escapeHtml(user.name)}</span></div>
      <div class="kv"><strong>Role</strong><span>${escapeHtml(user.role.replaceAll("_", " "))}</span></div>
      ${user.barangay ? `<div class="kv"><strong>Barangay</strong><span>${escapeHtml(user.barangay)}</span></div>` : ""}
      ${user.contact ? `<div class="kv"><strong>Contact</strong><span>${escapeHtml(user.contact)}</span></div>` : ""}
      <div class="kv"><strong>Email</strong><span>${escapeHtml(user.email)}</span></div>
      ${user.role === "HOUSEHOLD" ? `<div class="kv"><strong>Account status</strong><span>${accountBadge(user.status)}</span></div>` : ""}
      ${user.approvedAt ? `<div class="kv"><strong>Approved</strong><span>${formatDate(user.approvedAt)}</span></div>` : ""}
      ${user.rejectionReason ? `<div class="kv"><strong>Rejection reason</strong><span>${escapeHtml(user.rejectionReason)}</span></div>` : ""}
      </div>
    </section>
    <section class="dsws-panel dashboard-profile-panel">
      ${dswsPanelHeading("Change password", svg("shield"))}
      <div class="dsws-panel-body">
        <form class="form-grid" onsubmit="handleChangePassword(event)">
          <div class="field"><label for="currentPassword">Current password</label><div class="password-wrap"><input id="currentPassword" type="password" autocomplete="current-password" required placeholder="Enter current password">${passwordToggleMarkup("currentPassword")}</div></div>
          <div class="field"><label for="newPasswordProfile">New password</label><div class="password-wrap"><input id="newPasswordProfile" type="password" autocomplete="new-password" minlength="8" required placeholder="At least 8 characters">${passwordToggleMarkup("newPasswordProfile")}</div></div>
          <div class="field"><label for="confirmPasswordProfile">Confirm new password</label><div class="password-wrap"><input id="confirmPasswordProfile" type="password" autocomplete="new-password" minlength="8" required placeholder="Repeat new password">${passwordToggleMarkup("confirmPasswordProfile")}</div></div>
          <button class="btn btn-primary" type="submit">Update password</button>
        </form>
      </div>
    </section></div>`;
}
function requestTable(list, owner = false, actions = false, dsws = false) {
    if (!list.length)
        return `<div class="panel empty">No requests found.</div>`;
        return `<div class="table-wrap request-table-wrap"><table><thead><tr><th>Request</th><th>${owner ? "Barangay" : "Household"}</th><th>Need</th><th>Urgency</th><th>Status</th><th>Submitted</th><th>Action</th></tr></thead><tbody>${list.map(r => `
    <tr>
            <td data-label="Request"><strong>${escapeHtml(r.id)}</strong><div class="small muted">${escapeHtml(r.disaster)}</div></td>
            <td data-label="${owner ? "Barangay" : "Household"}">${owner ? escapeHtml(r.barangay) : `${escapeHtml(r.household)}<div class="small muted">${escapeHtml(r.barangay)}</div>`}</td>
            <td data-label="Need">${escapeHtml(r.category)}</td>
            <td data-label="Urgency">${urgencyBadge(r.urgency)}</td>
            <td data-label="Status">${badge(r.status)}${dsws && r.status === "Under Verification" && hoursSince(r.createdAt) >= 72 ? '<div class="small" style="color:var(--warning);margin-top:5px">Escalated</div>' : ""}${owner && r.rejectionReason ? `<div class="small" style="margin-top:5px"><strong>Rejection reason:</strong> ${escapeHtml(r.rejectionReason)}</div>` : ""}</td>
            <td data-label="Submitted">${formatDate(r.createdAt)}</td>
            <td data-label="Action">${actions ? barangayActions(r) : requestDetailActions(r)}</td>
    </tr>`).join("")}</tbody></table></div>`;
}
function donationTable(list) {
    if (!list.length)
        return `<div class="panel empty">No donations yet.</div>`;
    return `<div class="table-wrap request-table-wrap donation-table-wrap"><table><thead><tr><th>Donation</th><th>Barangay</th><th>Request</th><th>Type</th><th>Details</th><th>Status</th><th>Date</th><th>Action</th></tr></thead><tbody>${list.map(d => `
    <tr><td data-label="Donation"><strong>${escapeHtml(d.id)}</strong></td><td data-label="Barangay">${escapeHtml(d.barangay || "Community fund")}</td><td data-label="Request">${escapeHtml(d.requestId || "General donation")}</td><td data-label="Type">${escapeHtml(d.type)}</td><td data-label="Details">${escapeHtml(d.amount)}</td><td data-label="Status">${badge(d.status === "Reserved" ? "Pledged" : d.status)}</td><td data-label="Date">${formatDate(d.createdAt)}</td><td data-label="Action">${d.requestId ? `<div class="actions"><button class="btn btn-light btn-sm" onclick="openRequest(${toInlineJsArg(d.requestId)})">Details</button><button class="btn btn-light btn-sm" type="button" onclick="openDonationChat(${toInlineJsArg(d.id)})">Chat with barangay</button></div>` : `<div class="actions"><button class="btn btn-light btn-sm" onclick="openGeneralDonationDetails(${toInlineJsArg(d.id)})">Details</button><button class="btn btn-light btn-sm" onclick="openDonationChat(${toInlineJsArg(d.id)})">Chat</button></div>`}</td></tr>`).join("")} </tbody></table></div>`;
}
function generalDonationActions(donation) {
    if (donation.status !== "Pending Approval") {
        return `<div class="actions"><button class="btn btn-light btn-sm" onclick="openGeneralDonationDetails(${toInlineJsArg(donation.id)})">Details</button><button class="btn btn-light btn-sm" onclick="openDonationChat(${toInlineJsArg(donation.id)})">Chat</button></div>`;
    }
    return `<div class="actions"><button class="btn btn-primary btn-sm" onclick="approveGeneralDonation(${toInlineJsArg(donation.id)})">Approve</button><button class="btn btn-light btn-sm" onclick="rejectGeneralDonation(${toInlineJsArg(donation.id)})">Reject</button><button class="btn btn-light btn-sm" onclick="openDonationChat(${toInlineJsArg(donation.id)})">Chat</button></div>`;
}
function generalDonationList(list) {
    if (!list.length)
        return `<div class="panel empty">No general donations yet.</div>`;
    return `<div class="list">${list.map(d => `
    <div class="request-card">
      <div class="request-top">
        <div><strong>${escapeHtml(d.id)}</strong><div class="small muted" style="margin-top:3px">${escapeHtml(d.donor)} • ${escapeHtml(d.barangay)}</div></div>
        ${badge(d.status)}
      </div>
      <p>${escapeHtml(d.type)} • ${escapeHtml(d.amount)}</p>
      <div class="request-meta"><span>${escapeHtml(d.barangay)}</span><span>${formatDate(d.createdAt)}</span></div>
      ${generalDonationActions(d)}
    </div>`).join("")}</div>`;
}
function generalDonationConversationList(list) {
    if (!list.length)
        return `<div class="empty">No reviewed donation conversations yet.</div>`;
    return `<div class="list">${list.map(donation => `
    <article class="request-card">
      <div class="request-top"><div><strong>${escapeHtml(donation.donor)}</strong><div class="small muted">${escapeHtml(donation.id)} · ${escapeHtml(donation.type)}</div></div>${badge(donation.status)}</div>
      <p>${escapeHtml(donation.amount)}</p>
      <div class="actions"><button class="btn btn-light btn-sm" type="button" onclick="openGeneralDonationDetails(${toInlineJsArg(donation.id)})">Details</button><button class="btn btn-light btn-sm" type="button" onclick="openDonationChat(${toInlineJsArg(donation.id)})">Chat</button></div>
    </article>`).join("")}</div>`;
}
window.openGeneralDonationDetails = id => {
    const actor = session();
    const donation = getDonations().find(item => item.id === id && item.requestId === null);
    const canView = actor && donation && actor.status === "APPROVED" && (actor.role === "DSWS_ADMIN" ||
        (actor.role === "BARANGAY_OFFICIAL" && actor.barangay === donation.barangay) ||
        (actor.role === "DONOR" && actor.id === donation.donorId));
    if (!canView) {
        toast("You cannot view this donation.");
        return;
    }
    showModal(`<div class="modal-head"><h2>${escapeHtml(donation.id)}</h2><button class="icon-btn" aria-label="Close dialog" onclick="closeModal()">${svg("close")}</button></div>
    <div class="kv"><strong>Donor</strong><span>${escapeHtml(donation.donor)}</span></div>
    <div class="kv"><strong>Barangay</strong><span>${escapeHtml(donation.barangay || "—")}</span></div>
    <div class="kv"><strong>Type</strong><span>${escapeHtml(donation.type)}</span></div>
    <div class="kv"><strong>Details</strong><span>${escapeHtml(donation.amount)}</span></div>
    <div class="kv"><strong>Status</strong><span>${badge(donation.status)}</span></div>
    <div class="kv"><strong>Submitted</strong><span>${formatDate(donation.createdAt)}</span></div>
    ${donation.rejectionReason ? `<div class="kv"><strong>Rejection reason</strong><span>${escapeHtml(donation.rejectionReason)}</span></div>` : ""}
    ${actor.role === "DONOR" || actor.role === "BARANGAY_OFFICIAL" ? `<div class="actions"><button class="btn btn-primary" type="button" onclick="openDonationChat(${toInlineJsArg(donation.id)})">Open conversation</button></div>` : ""}`);
};

let activeDonationChat = null;
function donationChatMessagesHtml(messages, actor, emptyMessage = "No messages yet. Start the conversation to clarify this donation.") {
    if (!messages.length)
        return `<p class="donation-chat-empty">${escapeHtml(emptyMessage)}</p>`;
    return messages.map(message => {
        const own = message.senderId === actor.id;
        const role = message.senderRole === "DONOR" ? "Donor" : message.senderRole === "HOUSEHOLD" ? "Household" : "Barangay official";
        const time = Number.isFinite(Date.parse(message.createdAt))
            ? new Date(message.createdAt).toLocaleString("en-PH", { timeZone: "Asia/Manila", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })
            : "Time unavailable";
        return `<article class="donation-chat-message${own ? " is-own" : ""}" data-message-id="${escapeHtml(message.id)}"><div class="donation-chat-message-meta"><strong>${own ? "You" : escapeHtml(message.senderName)} <span>${own ? "" : `· ${role}`}</span></strong><time datetime="${escapeHtml(message.createdAt)}">${escapeHtml(time)}</time></div><p>${escapeHtml(message.message)}</p></article>`;
    }).join("");
}
function donationChatMarkup(donation, actor, messages = []) {
    const otherParty = actor.role === "DONOR" ? `Barangay team · ${donation.barangay}` : `Donor · ${donation.donor}`;
        const requestPledge = Boolean(donation.requestId);
        const status = donation.status === "Reserved" ? "Pledged" : donation.status;
        return `<div class="modal-head"><div><div class="modal-eyebrow">${requestPledge ? "Household request pledge" : "General donation"}</div><h2>Conversation</h2></div><button class="icon-btn" type="button" aria-label="Close dialog" onclick="closeModal()">${svg("close")}</button></div>
    <div class="donation-chat">
            <div class="donation-chat-context"><strong>${escapeHtml(donation.type)} donation</strong><span>${escapeHtml(otherParty)} · ${escapeHtml(status)}</span>${requestPledge ? `<p>Household request · ${escapeHtml(donation.requestId)}</p>` : ""}<p>${escapeHtml(donation.amount)}</p></div>
      <div id="donationChatMessages" class="donation-chat-messages" role="log" aria-label="Donation conversation" aria-live="polite" aria-relevant="additions text">${donationChatMessagesHtml(messages, actor)}</div>
      <p id="donationChatStatus" class="small muted donation-chat-status" role="status" aria-live="polite"></p>
      <form class="donation-chat-form" onsubmit="sendDonationMessage(event)"><label class="sr-only" for="donationChatInput">Message</label><textarea id="donationChatInput" name="message" rows="2" maxlength="2000" required placeholder="Write a message..."></textarea><button class="btn btn-primary" type="submit">Send message</button></form>
    </div>`;
}
window.openRequestDonorChat = async requestId => {
    if (!currentActor("BARANGAY_OFFICIAL")) {
        toast("An approved barangay official account is required.");
        return;
    }
    try {
        await refreshDashboardData(true);
        const pledges = getDonations().filter(donation => donation.requestId === requestId);
        if (!pledges.length) {
            toast("No donor pledge is available for this request.");
            return;
        }
        if (pledges.length === 1) {
            await window.openDonationChat(pledges[0].id);
            return;
        }
        showModal(`<div class="modal-head"><div><div class="modal-eyebrow">Request pledges</div><h2>Choose a donor</h2></div><button class="icon-btn" type="button" aria-label="Close dialog" onclick="closeModal()">${svg("close")}</button></div>
          <div class="list">${pledges.map(donation => `<article class="request-card"><div class="request-top"><strong>${escapeHtml(donation.donor)}</strong>${badge(donation.status === "Reserved" ? "Pledged" : donation.status)}</div><p>${escapeHtml(donation.type)} · ${escapeHtml(donation.amount)}</p><button class="btn btn-light btn-sm" type="button" onclick="openDonationChat(${toInlineJsArg(donation.id)})">Chat with ${escapeHtml(donation.donor)}</button></article>`).join("")}</div>`);
    }
    catch (error) { toast(error.message); }
};
window.openDonationChat = async id => {
    const actor = session();
    const donation = getDonations().find(item => item.id === id);
    const canChat = actor && donation && actor.status === "APPROVED" &&
        ((actor.role === "DONOR" && actor.id === donation.donorId) ||
            (actor.role === "BARANGAY_OFFICIAL" && actor.barangay === donation.barangay));
    if (!canChat) {
        toast("You cannot access this donation conversation.");
        return;
    }
    const chat = { id, donation, actor, timer: null, loading: false };
    showModal(donationChatMarkup(donation, actor), () => {
        if (chat.timer) clearInterval(chat.timer);
        if (activeDonationChat === chat) activeDonationChat = null;
    });
    document.querySelector("#modalRoot .modal")?.classList.add("donation-chat-modal");
    activeDonationChat = chat;
    await refreshDonationChat(true);
    if (activeDonationChat === chat)
        chat.timer = window.setInterval(() => refreshDonationChat(false), 5000);
};
window.refreshDonationChat = async (showFailure = true) => {
    const chat = activeDonationChat;
    if (!chat || chat.loading) return;
    chat.loading = true;
    try {
        const { messages } = await api(`/api/donations/${encodeURIComponent(chat.id)}/messages`);
        if (!Array.isArray(messages)) throw new Error("The server returned an invalid conversation.");
        if (activeDonationChat !== chat) return;
        const log = document.getElementById("donationChatMessages");
        if (!log) return;
        const signature = messages.map(message => message.id).join("|");
        if (log.dataset.signature !== signature) {
            const follow = log.scrollHeight - log.scrollTop - log.clientHeight < 48;
            log.innerHTML = donationChatMessagesHtml(messages, chat.actor);
            log.dataset.signature = signature;
            if (follow) log.scrollTop = log.scrollHeight;
        }
        const status = document.getElementById("donationChatStatus");
        if (status) status.textContent = "";
    }
    catch (error) {
        const status = document.getElementById("donationChatStatus");
        if (status && showFailure) status.textContent = error.message;
    }
    finally {
        chat.loading = false;
    }
};
window.sendDonationMessage = async event => {
    event.preventDefault();
    const chat = activeDonationChat;
    const form = event.currentTarget;
    const input = form.elements.message;
    const button = form.querySelector('button[type="submit"]');
    const message = input.value.trim();
    if (!chat || !message || message.length > 2000 || chat.sending) return;
    chat.sending = true;
    button.disabled = true;
    const status = document.getElementById("donationChatStatus");
    if (status) status.textContent = "Sending…";
    try {
        await api(`/api/donations/${encodeURIComponent(chat.id)}/messages`, { message });
        input.value = "";
        await refreshDonationChat(true);
        if (status) status.textContent = "Message sent.";
    }
    catch (error) {
        if (status) status.textContent = error.message;
    }
    finally {
        chat.sending = false;
        if (button.isConnected) button.disabled = false;
    }
};
let activeRequestChat = null;
function requestChatContextHtml(request, actor) {
    const otherParty = actor.role === "HOUSEHOLD" ? `Barangay team · ${request.barangay}` : `Household · ${request.household}`;
    const step = { Approved: 0, Pledged: 1, Fulfilled: 2 }[request.status];
    const guidance = {
        Approved: "Your request is approved and waiting for donor support.",
        Pledged: "Support is pledged. Coordinate pickup or delivery here.",
        Fulfilled: "Relief is marked as fulfilled. You can still follow up here."
    };
    return `<div class="request-chat-summary"><strong>${escapeHtml(request.category)} relief</strong>${badge(request.status)}</div>
      <span>${escapeHtml(otherParty)}</span><span>${escapeHtml(request.id)}</span>
      <ol class="request-chat-progress" aria-label="Relief progress">${["Approved", "Support pledged", "Fulfilled"].map((label, index) => `<li class="${index <= step ? "is-reached" : ""}"${index === step ? ' aria-current="step"' : ""}>${escapeHtml(label)}</li>`).join("")}</ol>
      <p>${escapeHtml(guidance[request.status] || "")}</p>
      ${request.fulfilledAt ? `<p>Fulfilled ${formatDate(request.fulfilledAt)}</p>` : ""}`;
}
function requestChatMarkup(request, actor) {
    return `<div class="modal-head"><div><div class="modal-eyebrow">Household relief</div><h2>Conversation</h2></div><button class="icon-btn" type="button" aria-label="Close dialog" onclick="closeModal()">${svg("close")}</button></div>
      <div class="donation-chat">
        <div id="requestChatContext" class="donation-chat-context">${requestChatContextHtml(request, actor)}</div>
        <div id="requestChatMessages" class="donation-chat-messages" role="log" aria-label="Household relief conversation" aria-live="polite" aria-relevant="additions text"><p class="donation-chat-empty">Loading conversation…</p></div>
        <p id="requestChatStatus" class="small muted donation-chat-status" role="status" aria-live="polite"></p>
        <form class="donation-chat-form" onsubmit="sendRequestMessage(event)"><label class="sr-only" for="requestChatInput">Message about your relief request</label><textarea id="requestChatInput" name="message" rows="2" maxlength="2000" required disabled placeholder="Ask about relief, pickup, or delivery…"></textarea><button class="btn btn-primary" type="submit" disabled>Send message</button></form>
      </div>`;
}
function updateRequestChatComposer(chat) {
    if (activeRequestChat !== chat) return;
    const input = document.getElementById("requestChatInput");
    if (!input) return;
    input.disabled = !chat.ready || chat.unavailable || chat.sending;
    input.form.querySelector('button[type="submit"]').disabled = input.disabled;
}
window.openRequestChat = async id => {
    const actor = session(), request = getRequests().find(item => item.id === id);
    if (!canRequestChat(request, actor)) {
        toast("This conversation is available to the household and its barangay after request approval.");
        return;
    }
    const chat = { id, actor, timer: null, loading: null, ready: false, sending: false, unavailable: false };
    showModal(requestChatMarkup(request, actor), () => {
        if (chat.timer) clearInterval(chat.timer);
        if (activeRequestChat === chat) activeRequestChat = null;
    });
    document.querySelector("#modalRoot .modal")?.classList.add("donation-chat-modal", "request-chat-modal");
    activeRequestChat = chat;
    await refreshRequestChat();
    if (activeRequestChat === chat && !chat.unavailable)
        chat.timer = window.setInterval(() => refreshRequestChat(), 5000);
};
window.refreshRequestChat = () => {
    const chat = activeRequestChat;
    if (!chat || chat.unavailable) return Promise.resolve(false);
    if (chat.loading) return chat.loading;
    chat.loading = (async () => {
        try {
            const { messages, request } = await api(`/api/requests/${encodeURIComponent(chat.id)}/messages`);
            if (activeRequestChat !== chat || session()?.id !== chat.actor.id) return false;
            if (!Array.isArray(messages) || request?.id !== chat.id || !canRequestChat(request, chat.actor))
                throw new Error("The server returned an invalid conversation.");
            const log = document.getElementById("requestChatMessages");
            if (!log) return false;
            const signature = messages.map(message => message.id).join("|");
            if (log.dataset.signature !== signature) {
                const follow = !chat.ready || log.scrollHeight - log.scrollTop - log.clientHeight < 48;
                log.innerHTML = donationChatMessagesHtml(messages, chat.actor, "No messages yet. Share relief updates or arrange pickup and delivery here.");
                log.dataset.signature = signature;
                if (follow) log.scrollTop = log.scrollHeight;
            }
            const context = document.getElementById("requestChatContext");
            const contextHtml = requestChatContextHtml(request, chat.actor);
            if (chat.contextHtml !== contextHtml) {
                context.innerHTML = contextHtml;
                chat.contextHtml = contextHtml;
            }
            if (dashboardDataCache.userId === chat.actor.id && Array.isArray(dashboardDataCache.requests))
                dashboardDataCache.requests = dashboardDataCache.requests.map(item => item.id === request.id ? request : item);
            chat.ready = true;
            if (!chat.sending) document.getElementById("requestChatStatus").textContent = "";
            updateRequestChatComposer(chat);
            return true;
        }
        catch (error) {
            if (activeRequestChat !== chat) return false;
            if ([401, 403, 404].includes(error.status)) {
                chat.unavailable = true;
                if (chat.timer) clearInterval(chat.timer);
                document.getElementById("requestChatMessages").replaceChildren();
            }
            document.getElementById("requestChatStatus").textContent = error.message;
            updateRequestChatComposer(chat);
            return false;
        }
        finally { chat.loading = null; }
    })();
    return chat.loading;
};
window.sendRequestMessage = async event => {
    event.preventDefault();
    const chat = activeRequestChat, form = event.currentTarget;
    const input = form.elements.message, message = input.value.trim();
    if (!chat || !chat.ready || chat.unavailable || chat.sending) return;
    const status = document.getElementById("requestChatStatus");
    if (!message || message.length > 2000) {
        status.textContent = "Enter a message with 1 to 2,000 characters.";
        input.focus();
        return;
    }
    chat.sending = true;
    updateRequestChatComposer(chat);
    status.textContent = "Sending…";
    try {
        await api(`/api/requests/${encodeURIComponent(chat.id)}/messages`, { message });
        if (activeRequestChat !== chat) return;
        input.value = "";
        // Finish an older poll before fetching the conversation containing this message.
        if (chat.loading) await chat.loading;
        if (activeRequestChat !== chat) return;
        const refreshed = await refreshRequestChat();
        if (activeRequestChat !== chat) return;
        if (refreshed) {
            const log = document.getElementById("requestChatMessages");
            log.scrollTop = log.scrollHeight;
            status.textContent = "Message sent.";
        }
        else if (!chat.unavailable) status.textContent = "Message sent. Waiting to refresh the conversation…";
    }
    catch (error) {
        if (activeRequestChat !== chat) return;
        status.textContent = error.message;
        if ([401, 403, 404].includes(error.status)) {
            chat.unavailable = true;
            if (chat.timer) clearInterval(chat.timer);
            document.getElementById("requestChatMessages").replaceChildren();
        }
    }
    finally {
        chat.sending = false;
        updateRequestChatComposer(chat);
        if (activeRequestChat === chat && !input.disabled) input.focus();
    }
};
window.openRequest = id => {
    const actor = session(), r = getRequests().find(x => x.id === id);
    const canView = actor && r && ((actor.role === "HOUSEHOLD" && ownsRequest(actor, r)) ||
        (actor.status === "APPROVED" && (actor.role === "DSWS_ADMIN" ||
            (actor.role === "BARANGAY_OFFICIAL" && actor.barangay === r.barangay) ||
            (actor.role === "DONOR" && (["Approved", "Under Verification"].includes(r.status) || getDonations().some(d => d.requestId === r.id && d.donorId === actor.id))))));
    if (!canView) {
        toast("You cannot view this request.");
        return;
    }
    const photos = Array.isArray(r.photos) ? r.photos.filter(photo => typeof photo === "string" && photo.length) : [];
    showModal(`<div class="request-details-view">
      <header class="modal-head request-detail-header">
        <div><div class="request-detail-eyebrow">Household assistance</div><h2>Request details</h2><p class="request-reference">${escapeHtml(r.id)}</p></div>
        <button class="icon-btn request-close" type="button" aria-label="Close dialog" onclick="closeModal()">${svg("close")}</button>
      </header>
      <div class="request-detail-body">
        ${canRequestChat(r, actor) ? `<div class="actions">${requestChatButton(r)}</div>` : ""}
        <section class="request-summary" aria-label="Household and request status">
          <span class="request-summary-icon" aria-hidden="true">${svg("home")}</span>
          <div class="request-summary-copy"><span>Household</span><strong>${escapeHtml(r.household)}</strong></div>
          <div class="request-statuses"><span aria-label="Urgency: ${escapeHtml(r.urgency)}">${urgencyBadge(r.urgency)}</span>${badge(r.status)}</div>
        </section>
        <div class="request-detail-grid">
          <div class="request-info"><span>Barangay</span><strong>${escapeHtml(r.barangay)}</strong></div>
          <div class="request-info"><span>Contact number</span><strong>${escapeHtml(r.contact)}</strong></div>
          <div class="request-info"><span>Assistance category</span><strong>${escapeHtml(r.category)}</strong></div>
          <div class="request-info"><span>Incident type</span><strong>${escapeHtml(r.disaster)}</strong></div>
          <div class="request-info request-info-wide"><span>Location</span><strong>${escapeHtml(r.location && r.location !== "Not provided" ? r.location : r.gps || "Not provided")}</strong>${parseGpsCoordinates(r.gps) || parseGpsCoordinates(r.location) ? `<div class="location-result">${gpsSummary(parseGpsCoordinates(r.gps) || parseGpsCoordinates(r.location), r.gpsAccuracy)}</div>` : ""}</div>
          <div class="request-info request-info-wide"><span>Submitted</span><strong>${formatDate(r.createdAt)}</strong></div>
        </div>
        ${r.rejectionReason ? `<section class="request-detail-section request-rejection"><h3>Rejection reason</h3><p class="request-description">${escapeHtml(r.rejectionReason)}</p></section>` : ""}
        <section class="request-detail-section"><h3><span class="request-section-icon" aria-hidden="true">${svg("report")}</span>Request description</h3><p class="request-description">${escapeHtml(r.description)}</p></section>
        <section class="request-detail-section" aria-labelledby="requestPhotosHeading">
          <div class="request-gallery-heading"><h3 id="requestPhotosHeading"><span class="request-section-icon" aria-hidden="true">${svg("eye")}</span>Household photos <span class="request-photo-count">${photos.length}</span></h3>${photos.length ? '<p>Select a photo to view it in full.</p>' : ""}</div>
          ${photos.length ? `<div class="request-photo-grid">${photos.map((photo, index) => `<button class="request-photo-card" type="button" data-photo-index="${index}" aria-label="View household photo ${index + 1} in full size"><span class="request-photo-preview"><img src="${escapeHtml(photo)}" alt="Photo ${index + 1} submitted by ${escapeHtml(r.household)}"><span class="request-photo-unavailable" hidden>Preview unavailable</span></span><span class="request-photo-caption"><span>Photo ${index + 1}</span><span aria-hidden="true">${svg("search")}</span></span></button>`).join("")}</div>` : '<div class="request-photos-empty">No photos were attached to this request.</div>'}
        </section>
      </div>
    </div>
    <div class="request-photo-viewer" hidden>
      <header class="request-viewer-header">
        <button class="request-viewer-back" type="button">${svg("arrow")}<span>Back to details</span></button>
        <h2 id="requestPhotoTitle" class="request-viewer-count" aria-live="polite">Household photo</h2>
        <button class="icon-btn request-close" type="button" aria-label="Close dialog" onclick="closeModal()">${svg("close")}</button>
      </header>
      <div class="request-photo-stage" tabindex="0" role="region" aria-label="Enlarged household photo. When zoomed, scroll to explore the image.">
        <img class="request-full-photo" alt="" hidden>
        <p class="request-photo-error" role="status" hidden>This photo could not be loaded. Try another photo or return to the request details.</p>
      </div>
      <footer class="request-viewer-footer">
        <button class="request-photo-prev" type="button" aria-label="Previous photo">${svg("arrow")}<span>Previous</span></button>
        <button class="request-photo-zoom" type="button" aria-pressed="false">${svg("search")}<span>Zoom in</span></button>
        <button class="request-photo-next" type="button" aria-label="Next photo"><span>Next</span>${svg("arrow")}</button>
      </footer>
    </div>`);
    const dialog = document.querySelector("#modalRoot .modal");
    dialog.classList.add("request-dialog");
    dialog.parentElement.classList.add("request-backdrop");
    setupRequestPhotoViewer(dialog, photos);
};
function setupRequestPhotoViewer(dialog, photos) {
    const details = dialog.querySelector(".request-details-view");
    const detailsBody = dialog.querySelector(".request-detail-body");
    const viewer = dialog.querySelector(".request-photo-viewer");
    const stage = dialog.querySelector(".request-photo-stage");
    const fullPhoto = dialog.querySelector(".request-full-photo");
    const errorMessage = dialog.querySelector(".request-photo-error");
    const count = dialog.querySelector(".request-viewer-count");
    const back = dialog.querySelector(".request-viewer-back");
    const previous = dialog.querySelector(".request-photo-prev");
    const next = dialog.querySelector(".request-photo-next");
    const zoom = dialog.querySelector(".request-photo-zoom");
    const thumbnails = [...dialog.querySelectorAll(".request-photo-card")];
    let photoIndex = 0, returnThumbnail = null, detailsScrollTop = 0;
    function resetZoom() {
        stage.classList.remove("is-zoomed");
        fullPhoto.style.removeProperty("width");
        fullPhoto.style.removeProperty("height");
        stage.scrollTop = 0;
        stage.scrollLeft = 0;
        zoom.setAttribute("aria-pressed", "false");
        zoom.querySelector("span").textContent = "Zoom in";
    }
    function showPhoto(index) {
        if (!Number.isInteger(index) || index < 0 || index >= photos.length) return;
        photoIndex = index;
        resetZoom();
        errorMessage.hidden = true;
        fullPhoto.hidden = false;
        zoom.disabled = true;
        fullPhoto.alt = `Household photo ${index + 1} of ${photos.length}`;
        fullPhoto.src = photos[index];
        count.textContent = `Photo ${index + 1} of ${photos.length}`;
        previous.disabled = index === 0;
        next.disabled = index === photos.length - 1;
        if (document.activeElement === previous && previous.disabled && !next.disabled) next.focus();
        if (document.activeElement === next && next.disabled && !previous.disabled) previous.focus();
    }
    function returnToDetails() {
        resetZoom();
        viewer.hidden = true;
        details.hidden = false;
        dialog.setAttribute("aria-labelledby", "modalTitle");
        detailsBody.scrollTop = detailsScrollTop;
        returnThumbnail?.focus({ preventScroll: true });
    }
    thumbnails.forEach((button, index) => {
        const preview = button.querySelector("img");
        const unavailable = button.querySelector(".request-photo-unavailable");
        const markUnavailable = () => { preview.hidden = true; unavailable.hidden = false; };
        preview.addEventListener("error", markUnavailable);
        if (preview.complete && !preview.naturalWidth) markUnavailable();
        button.addEventListener("click", () => {
            returnThumbnail = button;
            detailsScrollTop = detailsBody.scrollTop;
            details.hidden = true;
            viewer.hidden = false;
            dialog.setAttribute("aria-labelledby", "requestPhotoTitle");
            showPhoto(index);
            back.focus();
        });
    });
    fullPhoto.addEventListener("load", () => { zoom.disabled = false; });
    fullPhoto.addEventListener("error", () => {
        fullPhoto.hidden = true;
        errorMessage.hidden = false;
        zoom.disabled = true;
    });
    back.addEventListener("click", returnToDetails);
    previous.addEventListener("click", () => showPhoto(photoIndex - 1));
    next.addEventListener("click", () => showPhoto(photoIndex + 1));
    zoom.addEventListener("click", () => {
        if (stage.classList.contains("is-zoomed")) {
            resetZoom();
            return;
        }
        if (!fullPhoto.naturalWidth) return;
        const fitScale = Math.min(stage.clientWidth / fullPhoto.naturalWidth, stage.clientHeight / fullPhoto.naturalHeight);
        const zoomWidth = Math.max(fullPhoto.naturalWidth, fullPhoto.naturalWidth * fitScale * 2);
        stage.classList.add("is-zoomed");
        fullPhoto.style.width = `${Math.round(zoomWidth)}px`;
        fullPhoto.style.height = "auto";
        zoom.setAttribute("aria-pressed", "true");
        zoom.querySelector("span").textContent = "Fit photo";
    });
    dialog.addEventListener("keydown", event => {
        if (viewer.hidden) return;
        if (event.key === "Escape") {
            event.preventDefault();
            event.stopPropagation();
            returnToDetails();
        }
        else if (event.key === "ArrowLeft" || event.key === "ArrowRight") {
            if (stage.classList.contains("is-zoomed") && event.target === stage) return;
            event.preventDefault();
            showPhoto(photoIndex + (event.key === "ArrowLeft" ? -1 : 1));
        }
    });
}
// -----------------------------------------------------------------------------
// Modal handling
// -----------------------------------------------------------------------------
let modalReturnFocus = null;
let modalCleanup = null;
function getFocusableElements(container) {
    return [...container.querySelectorAll('a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])')].filter(element => !element.hidden && element.offsetParent !== null);
}
function showModal(html, onClose = null) {
    closeModal();
    modalCleanup = onClose;
    modalReturnFocus = document.activeElement;
    const backdrop = document.createElement("div");
    backdrop.id = "modalRoot";
    backdrop.className = "modal-backdrop";
    backdrop.innerHTML = `<div class="modal" role="dialog" aria-modal="true" tabindex="-1">${html}</div>`;
    const dialog = backdrop.querySelector(".modal");
    const heading = dialog?.querySelector("h2");
    if (heading) {
        heading.id = "modalTitle";
        dialog.setAttribute("aria-labelledby", "modalTitle");
    }
    else {
        dialog?.setAttribute("aria-label", "Details");
    }
    backdrop.addEventListener("click", event => {
        if (event.target === backdrop)
            closeModal();
    });
    backdrop.addEventListener("keydown", event => {
        if (event.key === "Escape") {
            event.preventDefault();
            closeModal();
            return;
        }
        if (event.key !== "Tab" || !dialog)
            return;
        const focusable = getFocusableElements(dialog);
        if (!focusable.length) {
            event.preventDefault();
            dialog.focus();
            return;
        }
        const first = focusable[0];
        const last = focusable[focusable.length - 1];
        if (event.shiftKey && document.activeElement === first) {
            event.preventDefault();
            last.focus();
        }
        else if (!event.shiftKey && document.activeElement === last) {
            event.preventDefault();
            first.focus();
        }
    });
    document.body.appendChild(backdrop);
    const app = document.getElementById("app");
    if (app)
        app.inert = true;
    requestAnimationFrame(() => {
        const first = getFocusableElements(dialog)[0];
        (first || dialog)?.focus();
    });
}
window.closeModal = () => {
    const cleanup = modalCleanup;
    modalCleanup = null;
    cleanup?.();
    document.getElementById("modalRoot")?.remove();
    const app = document.getElementById("app");
    if (app)
        app.inert = false;
    const previous = modalReturnFocus;
    modalReturnFocus = null;
    if (previous?.isConnected)
        previous.focus();
};
// -----------------------------------------------------------------------------
// Router and application lifecycle
// -----------------------------------------------------------------------------
function renderDashboardData(routeName, buildPage, setHtml) {
    const actor = dashboardDataActor();
    const hasData = dashboardDataCache.userId === actor?.id && Array.isArray(dashboardDataCache.requests) && Array.isArray(dashboardDataCache.donations);
    if (actor && !hasData && !dashboardDataCache.error) {
        const scope = actor.role === "DSWS_ADMIN" ? "citywide" : "barangay";
        setHtml(`<div class="container section"><p class="muted" role="status">Loading ${scope} dashboard data…</p></div>`);
        refreshDashboardData().then(() => {
            if (route()[0] === routeName) render();
        }, () => {
            if (route()[0] === routeName) render();
        });
        return;
    }
    if (actor && dashboardDataCache.error && !hasData) {
        setHtml(`<div class="container section"><div class="alert warning" role="alert"><p>${escapeHtml(dashboardDataCache.error)}</p><button class="btn btn-primary" type="button" onclick="retryDashboardData()">Retry</button></div></div>`);
        return;
    }
    setHtml(buildPage());
    if (actor && notificationState.userId !== actor.id && !notificationState.loading) {
        refreshNotifications().then(() => {
            if (route()[0] === routeName && !document.getElementById("modalRoot")) render();
        }).catch(() => {
            if (route()[0] === routeName && !document.getElementById("modalRoot")) render();
        });
    }
}
function render() {
    cancelLocationCapture();
    closeModal();
    try {
        if (!authState.ready) {
            document.getElementById("app").innerHTML = authShell('<div class="auth-card" role="status"><h1>Loading AYUDA…</h1><p>Checking your session.</p></div>');
            return;
        }
        init();
        let [r, sub] = route(), app = document.getElementById("app");
        const setHtml = html => { app.innerHTML = html; };
        if (!r) {
            setHtml(landing());
            return;
        }
        if (r === "about" || r === "how" || r === "security") {
            setHtml(landing());
            setTimeout(() => document.getElementById(r)?.scrollIntoView(), 30);
            return;
        }
        if (r === "login") {
            setHtml(loginPage());
            return;
        }
        if (r === "forgot-password") {
            setHtml(forgotPasswordPage());
            return;
        }
        if (r === "reset-password") {
            if (!validEmail(recoveryEmail)) {
                location.hash = "#/forgot-password";
                setHtml(forgotPasswordPage());
                return;
            }
            setHtml(recoveryCodePage());
            updateRecoveryCooldown();
            return;
        }
        if (r === "register") {
            setHtml(registerPage());
            return;
        }
        if (r === "household") {
            renderDashboardData(r, () => householdPage(sub || "overview"), setHtml);
            return;
        }
        if (r === "barangay") {
            renderDashboardData(r, () => barangayPage(sub || "overview"), setHtml);
            return;
        }
        if (r === "donor") {
            renderDashboardData(r, () => donorPage(sub || "overview"), setHtml);
            return;
        }
        if (r === "dsws") {
            renderDashboardData(r, () => dswsPage(sub || "overview"), setHtml);
            return;
        }
        setHtml(`<div class="container section"><h1 class="page-title">Page not found</h1><a href="#/" class="btn btn-primary">Back home</a></div>`);
    }
    finally {
        renderStorageNotice();
    }
}
window.retryDashboardData = () => {
    if (!dashboardDataActor())
        return;
    dashboardDataCache.userId = null;
    dashboardDataCache.requests = null;
    dashboardDataCache.donations = null;
    dashboardDataCache.error = "";
    render();
};
window.addEventListener("DOMContentLoaded", async () => {
    try {
        const savedEmail = sessionStorage.getItem("ayudaRecoveryEmail") || "";
        if (validEmail(savedEmail)) recoveryEmail = savedEmail;
        // Discard the previous demo's browser-generated reset code and browser session.
        sessionStorage.removeItem("ayudaPasswordRecovery");
        sessionStorage.removeItem("ayudaSessionPro");
    }
    catch { }
    render();
    try { await refreshAuth(); }
    catch (error) { authState.error = error.message; }
    finally { authState.ready = true; render(); }
});
window.addEventListener("hashchange", render);
window.addEventListener("pagehide", () => {
    const field = locationCapture?.field;
    cancelLocationCapture();
    if (field) setLocationStatus(field, field.dataset.coordinates ? "Location detection stopped. The displayed pin has been kept." : "Location detection stopped. Use precise location to try again.");
});
window.addEventListener("storage", e => {
    if (e.key === null || Object.values(STORAGE).includes(e.key))
        render();
});
let refreshingDashboardData = false;
function refreshTimedState() {
    if (authState.ready && dashboardDataActor() && !refreshingDashboardData && !document.querySelector("#app form") && !document.getElementById("modalRoot")) {
        refreshingDashboardData = true;
        Promise.allSettled([refreshDashboardData(true), refreshNotifications(true)]).then(() => {
            if (["household", "barangay", "donor", "dsws"].includes(route()[0]) && !document.querySelector("#app form") && !document.getElementById("modalRoot"))
                render();
        }).finally(() => { refreshingDashboardData = false; });
    }
    renderStorageNotice();
}
window.setInterval(refreshTimedState, 30000);
window.addEventListener("focus", refreshTimedState);
window.setInterval(updateRecoveryCooldown, 1000);
let refreshingAccountState = false;
async function refreshAccountState() {
    if (!authState.ready || refreshingAccountState || !/^https?:$/.test(location.protocol))
        return;
    refreshingAccountState = true;
    const before = JSON.stringify([authState.user, authState.users]);
    try {
        await refreshAuth();
        if (before !== JSON.stringify([authState.user, authState.users]) && !document.querySelector("#app form") && !document.getElementById("modalRoot"))
            render();
    }
    catch { /* Keep forms usable during temporary connection interruptions. */ }
    finally { refreshingAccountState = false; }
}
window.addEventListener("focus", refreshAccountState);
window.setInterval(refreshAccountState, 30000);
