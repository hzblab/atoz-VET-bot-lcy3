// ==UserScript==
// @name         LCY3 VET Auto-Add
// @namespace    local-lcy3-vet-alert
// @version      4.1
// @description  Detects LCY3 VET and tries to click the matching Add shift button on AtoZ
// @match        https://atoz.amazon.work/*
// @grant        GM_notification
// ==/UserScript==

(function () {
    "use strict";

    const TARGET_SITE = "LCY3";
    const TARGET_TYPE = "VOLUNTARYEXTRATIME";
    const SCAN_INTERVAL_MS = 5000;
    const CLICK_RETRY_INTERVAL_MS = 500;
    const CLICK_RETRY_COUNT = 20;
    const STORAGE_KEY = "lcy3_vet_seen_ids";

    let activeClicker = null;
    let lastStatus = "idle";
    let pendingRequests = 0;
    let idleReloadTimer = null;

    const seen = loadSeen();

    function loadSeen() {
        try {
            return new Set(JSON.parse(sessionStorage.getItem(STORAGE_KEY) || "[]"));
        } catch {
            return new Set();
        }
    }

    function saveSeen() {
        try {
            sessionStorage.setItem(STORAGE_KEY, JSON.stringify(Array.from(seen)));
        } catch {}
    }

    function logStatus(message) {
        lastStatus = `${new Date().toLocaleTimeString()}: ${message}`;
        console.log("[LCY3 VET]", message);
    }

    function normalizeText(value) {
        return String(value || "").replace(/[^A-Za-z0-9]/g, "").toUpperCase();
    }

    function getBodyText(node) {
        return (node?.textContent || "").replace(/\s+/g, " ").trim();
    }

    function parseBody(body) {
        if (!body) return null;
        if (typeof body === "string") {
            try { return JSON.parse(body); } catch { return null; }
        }
        if (body instanceof URLSearchParams) {
            const raw = body.get("operations") || body.get("body");
            if (raw) {
                try { return JSON.parse(raw); } catch { return null; }
            }
        }
        if (body instanceof FormData) {
            const raw = body.get("operations") || body.get("body");
            if (typeof raw === "string") {
                try { return JSON.parse(raw); } catch { return null; }
            }
        }
        return null;
    }

    function opportunityId(opportunity) {
        return opportunity?.id || opportunity?.opportunityId || opportunity?.shiftOpportunityId || null;
    }

    function isOpenOpportunity(opportunity) {
        const active = opportunity?.isActive ?? opportunity?.active ?? opportunity?.status === "ACTIVE";
        const open = opportunity?.isOpenForSignup ?? opportunity?.openForSignup ?? opportunity?.signupOpen ?? true;
        const full = opportunity?.isFull ?? opportunity?.full ?? false;
        const unavailability = Array.isArray(opportunity?.unavailability?.reasons) ? opportunity.unavailability.reasons : [];

        if (active === false) return [false, "inactive"];
        if (open === false) return [false, "closed"];
        if (full === true) return [false, "full"];
        if (unavailability.includes("ShiftOpportunityCapacityMet")) return [false, "capacity-met"];
        if (unavailability.includes("ShiftOpportunityExpired")) return [false, "expired"];
        return [true, "ok"];
    }

    function isLcy3Vet(opportunity) {
        const type = normalizeText(opportunity?.type || opportunity?.opportunityType || opportunity?.shiftOpportunityType);
        const site = opportunity?.siteId || opportunity?.associateSiteId || opportunity?.site?.id || opportunity?.site?.code || opportunity?.site?.name;
        const siteName = normalizeText(site);
        const [open, openReason] = isOpenOpportunity(opportunity);

        if (type !== TARGET_TYPE) return [false, `type=${type || "missing"}`];
        if (siteName && siteName !== TARGET_SITE) return [false, `site=${site}`];
        if (!open) return [false, openReason];
        return [true, "ok"];
    }

    function extractOpportunities(data) {
        return data?.data?.shiftOpportunities?.opportunities || [];
    }

    function visibleTextMatches(card, opportunity) {
        const text = getBodyText(card);
        if (!text) return false;

        const site = opportunity?.site?.name || opportunity?.siteId || TARGET_SITE;
        const start = opportunity?.timeRange?.start || opportunity?.startTime || opportunity?.shiftStartTime || "";
        const end = opportunity?.timeRange?.end || opportunity?.endTime || opportunity?.shiftEndTime || "";
        const duration = opportunity?.shift?.duration?.value || opportunity?.duration?.value || "";
        const skill = opportunity?.skill || opportunity?.skills?.defaultText || opportunity?.skills?.namespace || "";

        const matchSite = site ? text.includes(String(site)) : true;
        const matchStart = start ? text.includes(String(start).slice(11, 16)) || text.includes(String(start).slice(0, 10)) : true;
        const matchEnd = end ? text.includes(String(end).slice(11, 16)) || text.includes(String(end).slice(0, 10)) : true;
        const matchDuration = duration ? text.includes(String(duration)) : true;
        const matchSkill = skill ? text.includes(String(skill)) : true;
        const hasAdd = /Add shift/i.test(text);

        return hasAdd && matchSite && matchSkill && (matchStart || matchEnd || matchDuration);
    }

    function findMatchingCard(opportunity) {
        const candidates = Array.from(document.querySelectorAll("button, [role='button'], div, article, li, section"));
        return candidates.find((node) => visibleTextMatches(node, opportunity)) || null;
    }

    function clickAddShiftInCard(card) {
        if (!card) return false;
        const candidates = Array.from(card.querySelectorAll("button, [role='button']"));
        const btn = candidates.find((el) => /Add shift/i.test(getBodyText(el)));
        if (btn) {
            btn.click();
            return true;
        }
        return false;
    }

    function tryAutoAdd(opportunity) {
        if (activeClicker) clearInterval(activeClicker);
        let attempts = 0;
        activeClicker = setInterval(() => {
            attempts += 1;
            const card = findMatchingCard(opportunity);
            if (clickAddShiftInCard(card)) {
                logStatus("Clicked matching Add shift button.");
                clearInterval(activeClicker);
                activeClicker = null;
                return;
            }
            if (attempts >= CLICK_RETRY_COUNT) {
                logStatus("Could not find matching Add shift button in time.");
                clearInterval(activeClicker);
                activeClicker = null;
            }
        }, CLICK_RETRY_INTERVAL_MS);
    }

    function handleOpportunities(opportunities) {
        const matches = [];
        for (const opp of opportunities) {
            const id = opportunityId(opp) || JSON.stringify(opp);
            if (seen.has(id)) continue;

            const [ok, reason] = isLcy3Vet(opp);
            if (!ok) {
                logStatus(`Rejected opportunity: ${reason}`);
                continue;
            }

            seen.add(id);
            saveSeen();
            matches.push(opp);
        }

        if (!matches.length) return;

        const latest = matches[0];
        GM_notification({
            title: "LCY3 VET available",
            text: `${matches.length} matching opportunity found. Trying to add it now.`,
            timeout: 10000,
            onclick: () => window.focus()
        });

        logStatus(`${matches.length} matching opportunity found.`);
        tryAutoAdd(latest);
    }

    function inspectData(data) {
        const opportunities = extractOpportunities(data);
        if (!Array.isArray(opportunities)) return;
        if (!opportunities.length) {
            logStatus("No opportunities returned.");
            return;
        }
        handleOpportunities(opportunities);
    }

    function requestStarted() {
        pendingRequests += 1;
        if (idleReloadTimer) {
            clearTimeout(idleReloadTimer);
            idleReloadTimer = null;
        }
    }

    function requestFinished() {
        pendingRequests = Math.max(0, pendingRequests - 1);
        if (pendingRequests === 0) scheduleIdleReload();
    }

    function scheduleIdleReload() {
        if (idleReloadTimer) return;
        idleReloadTimer = setTimeout(() => {
            idleReloadTimer = null;
            if (pendingRequests === 0 && location.href.toLowerCase().includes("shift")) {
                location.reload();
            }
        }, SCAN_INTERVAL_MS);
    }

    const originalFetch = window.fetch;
    window.fetch = async function (...args) {
        requestStarted();
        try {
            const response = await originalFetch.apply(this, args);
            try {
                const request = args[0];
                const options = args[1] || {};
                let body = options.body;
                if (request instanceof Request && !body) body = await request.clone().text();
                const bodyObj = parseBody(body);
                const operationName = bodyObj?.operationName;
                if (bodyObj && operationName === "FindShiftsPage") {
                    const cloned = response.clone();
                    const data = await cloned.json();
                    inspectData(data);
                }
            } catch (error) {
                console.warn("[LCY3 VET] fetch parse error:", error);
            }
            return response;
        } finally {
            requestFinished();
        }
    };

    const originalOpen = XMLHttpRequest.prototype.open;
    const originalSend = XMLHttpRequest.prototype.send;

    XMLHttpRequest.prototype.open = function (...args) {
        this._lcy3_url = args[1];
        return originalOpen.apply(this, args);
    };

    XMLHttpRequest.prototype.send = function (body) {
        requestStarted();
        try {
            const bodyObj = parseBody(body);
            if (bodyObj && bodyObj.operationName === "FindShiftsPage") {
                this.addEventListener("load", function () {
                    try {
                        const data = JSON.parse(this.responseText);
                        inspectData(data);
                    } catch (error) {
                        console.warn("[LCY3 VET] XHR parse error:", error);
                    }
                });
            }
        } catch (error) {
            console.warn("[LCY3 VET] XHR hook error:", error);
        }
        this.addEventListener("loadend", requestFinished);
        return originalSend.call(this, body);
    };

    setInterval(() => {
        logStatus(`seen=${seen.size}; pending=${pendingRequests}; last=${lastStatus}`);
        if (pendingRequests === 0 && location.href.toLowerCase().includes("shift")) {
            scheduleIdleReload();
        }
    }, SCAN_INTERVAL_MS);

    console.log("LCY3 VET auto-add active.");
})();