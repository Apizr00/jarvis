// src/plugins/builtin/prayertimes-widget/index.js
// ── Prayer Times Widget Plugin ───────────────────────────────────────────────
//
// Registers a "Waktu Solat" widget for the Jarvis Playground dashboard.
// The widget displays Malaysian prayer times from JAKIM e-Solat API.
// Data comes from the existing /api/prayertimes endpoint.

const ZONES = {
  WLY01: 'Kuala Lumpur & Putrajaya',
  WLY02: 'Labuan',
  SGR01: 'Gombak, Petaling, Sepang, Hulu Langat…',
  SGR02: 'Kuala Selangor, Sabak Bernam',
  SGR03: 'Klang, Kuala Langat',
  JHR01: 'Johor Bahru, Kulai, Pontian, Kota Tinggi',
  JHR02: 'Batu Pahat, Muar, Segamat…',
  JHR03: 'Kluang',
  JHR04: 'Mersing',
  KDH01: 'Alor Setar, Kuala Muda, Pendang…',
  KDH02: 'Langkawi',
  KDH03: 'Kulim, Bandar Baharu',
  KDH04: 'Kubang Pasu, Kota Setar',
  KDH05: 'Baling, Sik',
  KDH06: 'Gunung Jerai',
  KDH07: 'Padang Terap',
  KTN01: 'Kota Bharu, Bachok, Tumpat…',
  KTN02: 'Gua Musang',
  MLK01: 'Melaka, Alor Gajah, Jasin',
  NGS01: 'Seremban, Port Dickson, Rembau…',
  NGS02: 'Gemas',
  PHG01: 'Kuantan, Pekan, Rompin, Bera…',
  PHG02: 'Cameron Highlands, Raub, Bentong…',
  PHG03: 'Rompin',
  PHG04: 'Bera',
  PHG05: 'Jerantut',
  PHG06: 'Pekan',
  PRK01: 'Ipoh, Kuala Kangsar, Manjung…',
  PRK02: 'Taiping, Selama, Kerian…',
  PRK03: 'Hulu Perak',
  PRK04: 'Batang Padang',
  PRK05: 'Muallim',
  PRK06: 'Kampar',
  PRK07: 'Bagan Datuk',
  PLS01: 'Perlis',
  PNG01: 'Pulau Pinang',
  SBH01: 'Kota Kinabalu, Ranau, Tuaran, Penampang…',
  SBH02: 'Sandakan, Tawau, Lahad Datu…',
  SBH03: 'Kudat, Pitas',
  SBH04: 'Keningau, Tambunan, Tenom',
  SBH05: 'Beaufort, Kuala Penyu, Sipitang',
  SBH06: 'Beluran, Telupid',
  SBH07: 'Nabawan',
  SBH08: 'Pensiangan',
  SBH09: 'Tongod',
  SWK01: 'Kuching, Samarahan, Serian…',
  SWK02: 'Sibu, Mukah, Bintulu, Miri…',
  SWK03: 'Limbang',
  SWK04: 'Miri',
  SWK05: 'Kapit',
  SWK06: 'Sarikei',
  SWK07: 'Sri Aman',
  SWK08: 'Betong',
  SWK09: 'Samarahan',
  TRG01: 'Kuala Terengganu, Marang, Besut…',
  TRG02: 'Dungun',
  TRG03: 'Kemaman',
  TRG04: 'Setiu',
};

/**
 * onInit — called when plugin is loaded.
 * Registers the Waktu Solat widget.
 */
async function onInit(ctx) {
  ctx.registerWidget({
    id: 'waktu-solat',
    title: 'Waktu Solat',
    icon: '🕌',
    type: 'card',
    description: 'Waktu solat harian dari JAKIM e-Solat. Memaparkan waktu solat fardu, countdown ke solat seterusnya, dan tarikh Hijrah.',
    defaultSize: { w: 2, h: 2 },
    minSize: { w: 1, h: 2 },
    maxSize: { w: 4, h: 3 },
    refreshInterval: 300000, // Refresh every 5 minutes
    endpoint: '/api/prayertimes',
    permissions: [],
    config: {
      defaultZone: 'WLY01',
      showImsak: true,
      showSyuruk: true,
      showDhuha: false,
      countdown: true,
    },
  });

  // Also register a full-page prayer times view
  ctx.registerPage({
    path: '/waktu-solat',
    title: 'Waktu Solat',
    icon: '🕌',
    component: 'prayertimes-page',
    layout: 'default',
    permissions: [],
    config: {
      endpoint: '/api/prayertimes',
    },
  });

  ctx.logger.info('Prayer Times widget registered');
}

/**
 * onEnable — called when plugin is enabled.
 */
async function onEnable(ctx) {
  ctx.logger.info('Prayer Times plugin enabled');
}

/**
 * onDisable — called when plugin is disabled.
 */
async function onDisable(ctx) {
  ctx.logger.info('Prayer Times plugin disabled');
}

module.exports = { onInit, onEnable, onDisable };
