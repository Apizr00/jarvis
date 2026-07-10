import { useState, useEffect } from "react";
import "./WaktuSolatPage.css";

const PRAYER_ORDER = [
  "imsak",
  "fajr",
  "syuruk",
  "dhuha",
  "dhuhr",
  "asr",
  "maghrib",
  "isha",
];
const PRAYER_LABELS = {
  imsak: "Imsak",
  fajr: "Subuh",
  syuruk: "Syuruk",
  dhuha: "Dhuha",
  dhuhr: "Zohor",
  asr: "Asar",
  maghrib: "Maghrib",
  isha: "Isyak",
};
const PRAYER_ICONS = {
  imsak: "🌙",
  fajr: "🌅",
  syuruk: "☀️",
  dhuha: "🌤️",
  dhuhr: "☀️",
  asr: "🌤️",
  maghrib: "🌇",
  isha: "🌙",
};
const OBLIGATORY = ["fajr", "dhuhr", "asr", "maghrib", "isha"];

export default function WaktuSolatPage() {
  const [zone, setZone] = useState(
    localStorage.getItem("prayerZone") || "WLY01",
  );
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [countdown, setCountdown] = useState("");

  const fetchTimes = async () => {
    setLoading(true);
    try {
      const res = await fetch(
        `/api/prayertimes?zone=${encodeURIComponent(zone)}`,
      );
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const d = await res.json();
      setData(d);
      setError(null);
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchTimes();
  }, [zone]);

  // Countdown timer
  useEffect(() => {
    if (!data?.timings) return;
    const interval = setInterval(() => {
      const now = new Date();
      const today = now.toISOString().split("T")[0];
      let nextPrayer = null;

      for (const key of OBLIGATORY) {
        const timeStr = data.timings[key];
        if (!timeStr) continue;
        const [h, m] = timeStr.split(":").map(Number);
        const pd = new Date(
          `${today}T${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:00+08:00`,
        );
        if (pd > now) {
          nextPrayer = { key, date: pd };
          break;
        }
      }

      if (nextPrayer) {
        const diff = nextPrayer.date - now;
        const hours = Math.floor(diff / 3600000);
        const minutes = Math.floor((diff % 3600000) / 60000);
        setCountdown(
          `${PRAYER_LABELS[nextPrayer.key]} dalam ${hours}j ${minutes}m`,
        );
      } else {
        setCountdown("Semua waktu solat telah berlalu");
      }
    }, 30000);
    return () => clearInterval(interval);
  }, [data]);

  if (loading) {
    return (
      <div className="ws-page">
        <div className="ws-card card">
          {Array(6)
            .fill(null)
            .map((_, i) => (
              <div
                key={i}
                className="skeleton"
                style={{ height: 48, marginBottom: 8 }}
              />
            ))}
        </div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="ws-page">
        <div className="state-message">
          <div className="state-icon">⚠️</div>
          <div className="state-title">Gagal Mendapatkan Data</div>
          <div className="state-desc">{error}</div>
          <button
            className="btn btn-primary"
            onClick={fetchTimes}
            style={{ marginTop: 16 }}
          >
            🔄 Cuba Lagi
          </button>
        </div>
      </div>
    );
  }

  const now = new Date();
  const today = now.toISOString().split("T")[0];
  let nextFound = false;

  return (
    <div className="ws-page fade-in">
      <div className="ws-card card">
        <div className="ws-date-card">
          <div className="ws-gregorian">{data?.date || "—"}</div>
          <div className="ws-hijri">{data?.hijri ? `${data.hijri}H` : "—"}</div>
          <div className="ws-day">{data?.day || "—"}</div>
        </div>

        <div className="ws-zone">
          <select
            value={zone}
            onChange={(e) => {
              setZone(e.target.value);
              localStorage.setItem("prayerZone", e.target.value);
            }}
          >
            {Object.entries(ZONES).map(([code, name]) => (
              <option key={code} value={code}>
                {code} — {name}
              </option>
            ))}
          </select>
          <button className="btn btn-sm" onClick={fetchTimes}>
            🔄
          </button>
        </div>

        <div className="ws-prayers">
          {PRAYER_ORDER.map((key) => {
            const timeStr = data?.timings?.[key];
            if (!timeStr) return null;

            const [h, m] = timeStr.split(":").map(Number);
            const pd = new Date(
              `${today}T${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:00+08:00`,
            );
            const isPast = now > pd;
            const isObligatory = OBLIGATORY.includes(key);
            const isNext = !isPast && isObligatory && !nextFound;
            if (isNext) nextFound = true;

            const time12h = new Date(
              `2000-01-01T${timeStr}`,
            ).toLocaleTimeString("en-US", {
              hour: "numeric",
              minute: "2-digit",
              hour12: true,
            });

            return (
              <div
                key={key}
                className={`ws-prayer-row ${isPast ? "past" : ""} ${isNext ? "next" : ""}`}
              >
                <div className="ws-prayer-left">
                  <span className="ws-prayer-icon">{PRAYER_ICONS[key]}</span>
                  <span className="ws-prayer-name">{PRAYER_LABELS[key]}</span>
                </div>
                <span className="ws-prayer-time">{time12h}</span>
              </div>
            );
          })}
        </div>

        {countdown && <div className="ws-countdown">{countdown}</div>}

        <div className="ws-footer">
          <span>
            <span className="status-dot ok" /> Live · JAKIM e-Solat
          </span>
        </div>
      </div>
    </div>
  );
}

const ZONES = {
  WLY01: "Kuala Lumpur & Putrajaya",
  WLY02: "Labuan",
  SGR01: "Gombak, Petaling, Sepang, Hulu Langat…",
  SGR02: "K. Selangor, Sabak Bernam",
  SGR03: "Klang, K. Langat",
  JHR01: "JB, Kulai, Pontian, Kota Tinggi",
  JHR02: "Batu Pahat, Muar, Segamat…",
  JHR03: "Kluang",
  JHR04: "Mersing",
  KDH01: "Alor Setar, K. Muda, Pendang…",
  KDH02: "Langkawi",
  KDH03: "Kulim, Bandar Baharu",
  MLK01: "Melaka, Alor Gajah, Jasin",
  NGS01: "Seremban, PD, Rembau…",
  PHG01: "Kuantan, Pekan, Rompin, Bera…",
  PHG02: "Cameron Highlands, Raub, Bentong…",
  PRK01: "Ipoh, K. Kangsar, Manjung…",
  PLS01: "Perlis",
  PNG01: "Pulau Pinang",
  SBH01: "KK, Ranau, Tuaran, Penampang…",
  SBH02: "Sandakan, Tawau, Lahad Datu…",
  SWK01: "Kuching, Samarahan, Serian…",
  SWK02: "Sibu, Mukah, Bintulu, Miri…",
  TRG01: "K. Terengganu, Marang, Besut…",
  TRG02: "Dungun",
  TRG03: "Kemaman",
};
