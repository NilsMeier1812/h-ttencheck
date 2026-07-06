// api/check.js — Vercel Serverless Function
// Prueft hut-reservation.org auf freie Plaetze und mailt via Resend,
// wenn Platz frei ist. Kein State, keine Dedup: laeuft eine Meldung frei,
// kommt bei jedem Aufruf eine Mail (bei 1h-Cron also stuendlich, bis du
// buchst und den Cronjob deaktivierst).

// ----------------------- KONFIG (hier editieren) -----------------------
const HUT_ID    = 150;
const NIGHTS    = ["28.07.2026", "29.07.2026", "15.07.2026"];   // Anreisedaten, je genau 1 Nacht
const MIN_FREE  = 1;                               // ab so vielen freien Plaetzen melden
const MAIL_TO   = "nils-er@gmx.de";
const MAIL_FROM = "Hütten-Watcher <huette@nils-meier.de>"; // <- deine verifizierte Resend-Domain
// RESEND_API_KEY kommt aus den Vercel-Env-Vars (nicht ins Repo!).
// Optionaler Schutz: CRON_SECRET als Env setzen -> dann Header/Query noetig.
// -----------------------------------------------------------------------

const BASE = "https://www.hut-reservation.org/api/v1";
const BOOK_URL = `https://www.hut-reservation.org/reservation/book-hut/${HUT_ID}/wizard`;

const HDRS = {
  "User-Agent": "Mozilla/5.0",
  Accept: "application/json",
  "Content-Type": "application/json",
  Origin: "https://www.hut-reservation.org",
  Referer: "https://www.hut-reservation.org/reservation",
};

function plusOneDay(ddmmyyyy) {
  const [d, m, y] = ddmmyyyy.split(".").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  dt.setUTCDate(dt.getUTCDate() + 1);
  const p = (n) => String(n).padStart(2, "0");
  return `${p(dt.getUTCDate())}.${p(dt.getUTCMonth() + 1)}.${dt.getUTCFullYear()}`;
}

async function hutInfo() {
  const r = await fetch(`${BASE}/reservation/hutInfo/${HUT_ID}`, { headers: HDRS });
  if (!r.ok) throw new Error(`hutInfo ${r.status}`);
  return r.json();
}

async function freeForNight(categories, arrival) {
  const payload = {
    arrivalDate: arrival,
    departureDate: plusOneDay(arrival),
    numberOfPeople: 0,
    nextPossibleReservations: false,
    peoplePerCategory: categories.map((c) => ({ categoryId: c.categoryID, people: 0 })),
    isWaitingListAccepted: false,
    reservationPublicId: "",
  };
  const r = await fetch(`${BASE}/reservation/checkAvailability/${HUT_ID}`, {
    method: "POST", headers: HDRS, body: JSON.stringify(payload),
  });
  if (!r.ok) throw new Error(`checkAvailability ${r.status}`);
  const data = await r.json();
  const days = data.availabilityPerDayDTOs || [];
  if (!days.length) return { free: 0, breakdown: [] };
  let free = 0;
  const breakdown = [];
  for (const c of days[0].bedCategoriesData || []) {
    const labels = c.hutBedCategoryLanguagesData || [];
    const de = labels.find((l) => l.language === "DE");
    const label = (de || labels[0] || {}).label || "Kategorie";
    const f = c.totalFreePlaces || 0;
    free += f;
    breakdown.push({ label, free: f, total: c.totalPlaces || 0 });
  }
  return { free, breakdown };
}

async function sendMail(hutName, hits) {
  const rows = hits.map(({ night, free, breakdown }) => {
    const cats = breakdown.filter((b) => b.free > 0)
      .map((b) => `<li>${b.label}: <b>${b.free}</b> frei / ${b.total}</li>`).join("");
    return `<h3>Nacht ${night} – ${free} Plätze frei</h3><ul>${cats}</ul>`;
  }).join("");
  const html = `<h2>Freier Platz: ${hutName}</h2>${rows}` +
               `<p><a href="${BOOK_URL}">Jetzt buchen →</a></p>`;
  const subject = `Platz frei: ${hutName} (${hits.map((h) => h.night).join(", ")})`;
  const r = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${process.env.RESEND_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ from: MAIL_FROM, to: [MAIL_TO], subject, html }),
  });
  if (!r.ok) throw new Error(`resend ${r.status}: ${await r.text()}`);
  return (await r.json()).id;
}

export default async function handler(req, res) {
  // Optionaler Schutz: nur pruefen, wenn CRON_SECRET gesetzt ist.
  const secret = process.env.CRON_SECRET;
  if (secret) {
    const auth = req.headers.authorization || "";
    const provided = auth.startsWith("Bearer ") ? auth.slice(7) : (req.query.secret || "");
    if (provided !== secret) return res.status(401).json({ error: "unauthorized" });
  }

  try {
    // Testmail: /api/check?test=1  -> verschickt sofort eine Dummy-Mail.
    if (req.query.test) {
      const id = await sendMail("TEST – Setup-Check", [
        { night: "TEST", free: 99, breakdown: [{ label: "Testlager", free: 99, total: 99 }] },
      ]);
      return res.status(200).json({ ok: true, test: true, mailId: id });
    }

    const info = await hutInfo();
    const hutName = info.hutName || `Hütte ${HUT_ID}`;
    const cats = (info.hutBedCategories || []).filter((c) => c.isVisible);

    const hits = [];
    const summary = [];
    for (const night of NIGHTS) {
      const { free, breakdown } = await freeForNight(cats, night);
      summary.push({ night, free });
      if (free >= MIN_FREE) hits.push({ night, free, breakdown });
    }

    let mailId = null;
    if (hits.length) mailId = await sendMail(hutName, hits);

    return res.status(200).json({
      ok: true, hut: hutName, summary,
      mailed: hits.map((h) => h.night), mailId,
    });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ error: String(e.message || e) });
  }
}
