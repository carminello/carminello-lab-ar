/**
 * DUCK HUNT — 360° WebAR FPS Wave Survival
 * Powered by CarminelloLab
 * WebAR Survival Shooter a Ondate Progressive con Punti Vita (HP) & IA Nemica Avanzata
 * 
 * Moduli e Architettura:
 * 1. Modalità Wave Survival (Ondate Progressive):
 *    - Timer 45s eliminato: il gioco continua fino all'esaurimento dei 100 HP del giocatore
 *    - Array di configurazione livelli (WAVE_CONFIG 1-5+) con arsenale crescente
 *    - Transizione ondate: banner animato di 3s, rigenerazione parziale HP (+20 HP)
 * 2. Arsenale Paperelle & FSM Nemica:
 *    - Livello 1: Tutorial (volo base d'esplorazione, passive)
 *    - Livello 2: Beccata CQC (Dive verso la camera, 10 HP danno)
 *    - Livello 3: Coltello (mesh lama metallica, scatti a zigzag rapidi, 20 HP danno)
 *    - Livello 4: Pistola (mesh pistola, proiettili 3D luminosi da 15 HP intercettabili)
 *    - Livello 5+: Bazooka RPG & Elmetto (razzo 3D con scia di fumo, 45 HP danno, camera shake)
 * 3. Hitbox Giocatore, Feedback Danni & Camera Shake:
 *    - Danneggiamento: #damage-flash rosso vivo, scossa fisica Three.js della camera con decadimento lerp
 *    - Game Over personalizzato con livello massimo raggiunto, paperelle abbattute e danni subiti
 * 4. Interazione Computer Vision (COCO-SSD):
 *    - Scansione disaccoppiata a 350ms, appollaiamento su oggetti fisici reali e bonus punti 2X
 * 5. Mobile Performance Benchmark & Zero GC Allocations:
 *    - Pool di scratch objects riutilizzati, 60 FPS garantiti
 */

(() => {
  'use strict';

  // =========================================================================
  // PARSER PROMEMORIA VOCALI & CALENDARIO SMARTPHONE (GOOGLE & APPLE CALENDAR)
  // =========================================================================

  /**
   * Converte una data in formato ISO compatto per Google Calendar e iCal (YYYYMMDDTHHmmssZ)
   */
  function formatGCalDate(d) {
    const pad = (n) => String(n).padStart(2, '0');
    return '' + d.getUTCFullYear() +
      pad(d.getUTCMonth() + 1) +
      pad(d.getUTCDate()) + 'T' +
      pad(d.getUTCHours()) +
      pad(d.getUTCMinutes()) +
      pad(d.getUTCSeconds()) + 'Z';
  }

  /**
   * Rimuove stuttering, parole duplicate ed eco di frasi causate dai riavvii
   * o dalle correzioni intermedie della Web Speech API su mobile.
   * @param {string} text Frase trascritta
   * @returns {string} Frase ripulita senza ripetizioni
   */
  function deduplicateTranscript(text) {
    if (!text) return '';
    let s = String(text).replace(/\s+/g, ' ').trim();
    if (!s) return '';

    const cleanWord = (w) => String(w || '').toLowerCase().replace(/^[^\w\u00C0-\u017F]+|[^\w\u00C0-\u017F]+$/g, '');

    // 1. Rimuove sequenze o frasi identiche consecutive (da 12 parole fino a 2)
    let words = s.split(' ');
    let changed = true;
    let guard = 0;
    while (changed && guard < 25) {
      guard++;
      changed = false;
      const nWords = words.length;
      const maxSpan = Math.min(12, Math.floor(nWords / 2));
      for (let span = maxSpan; span >= 2; span--) {
        for (let i = 0; i <= words.length - 2 * span; i++) {
          const chunk1 = words.slice(i, i + span).map(cleanWord).join(' ');
          const chunk2 = words.slice(i + span, i + 2 * span).map(cleanWord).join(' ');
          if (chunk1 && chunk1 === chunk2) {
            words.splice(i, span);
            changed = true;
            break;
          }
        }
        if (changed) break;
      }
    }

    s = words.join(' ');

    // 2. Rimuove singole parole ripetute consecutive (anche con punteggiatura)
    s = s.replace(/\b(\w+)(?:[\s,.;:!?]+\1\b)+/gi, '$1');

    return s.replace(/\s+/g, ' ').trim();
  }

  /**
   * Analizza la frase italiana dell'utente per estrarre titolo, data e orario di scadenza
   * @param {string} transcript Testo vocale dell'utente
   * @returns {object} { title, startDate, endDate, humanDate }
   */
  function parseReminderText(transcript) {
    const raw = deduplicateTranscript(String(transcript || '')).trim();
    const now = new Date();

    if (!raw) {
      const defaultStart = new Date(now.getTime() + 60 * 60 * 1000);
      defaultStart.setMinutes(0, 0, 0);
      return {
        title: 'Promemoria Mr.Duck',
        startDate: defaultStart,
        endDate: new Date(defaultStart.getTime() + 30 * 60 * 1000),
        humanDate: 'Tra un ora'
      };
    }

    // 1. Pulizia prefissi vocali
    let clean = raw
      .replace(/^(?:ehi\s+)?(?:mr\.?\s*duck\s*,?\s*)/i, '')
      .replace(/^(?:vorrei\s+)?(?:crea(?:re)?|metti|imposta|aggiungi)?\s*(?:un\s+)?(?:nuovo\s+)?promemoria(?:\s+(?:per|di|su))?\s*/i, '')
      .replace(/^(?:ti\s+prego\s+di\s+)?(?:ricorda(?:mi|ti)?|avvisa(?:mi|ti)?|segna(?:mi|ti)?|appunta(?:mi|ti)?|fissa(?:mi|ti)?)\s*(?:di|per|a|che)?\s*/i, '')
      .replace(/^(?:non\s+dimenticare\s+(?:di)?)\s*/i, '')
      .trim();

    let startDate = null;
    let humanDate = '';
    let matchedTimePhrases = [];

    // 2. Pattern A: Relativo ("tra 20 minuti", "tra 2 ore", "tra mezzora", "tra un ora")
    const relRegex = /\btra\s+(\d+|un|una|uno|mezz|mezza)\s*(minut[io]|or[ae])\b/i;
    const mRel = clean.match(relRegex);
    if (mRel) {
      matchedTimePhrases.push(mRel[0]);
      const qtyStr = mRel[1].toLowerCase();
      const unit = mRel[2].toLowerCase();
      let deltaMs = 0;

      if (qtyStr.indexOf('mezz') !== -1) {
        deltaMs = 30 * 60 * 1000;
        humanDate = 'Tra mezz ora';
      } else if (qtyStr === 'un' || qtyStr === 'una' || qtyStr === 'uno') {
        deltaMs = (unit.indexOf('or') !== -1) ? 60 * 60 * 1000 : 60 * 1000;
        humanDate = (unit.indexOf('or') !== -1) ? 'Tra un ora' : 'Tra 1 minuto';
      } else {
        const n = parseInt(qtyStr, 10) || 1;
        deltaMs = ((unit.indexOf('or') !== -1) ? n * 60 * 60 : n * 60) * 1000;
        humanDate = `Tra ${n} ${unit}`;
      }

      startDate = new Date(now.getTime() + deltaMs);
      const hh = String(startDate.getHours()).padStart(2, '0');
      const mm = String(startDate.getMinutes()).padStart(2, '0');
      humanDate += ` (${hh}:${mm})`;
    }

    // 3. Pattern B: Giorni ed orari specifici ("domani alle 15:30", "oggi alle 18", "dopodomani alle 10")
    if (!startDate) {
      let dayOffset = null;
      let dayWord = '';

      if (/\bdopodomani\b/i.test(clean)) {
        dayOffset = 2;
        dayWord = 'Dopodomani';
        matchedTimePhrases.push('dopodomani');
      } else if (/\bdomani\b/i.test(clean)) {
        dayOffset = 1;
        dayWord = 'Domani';
        matchedTimePhrases.push('domani');
      } else if (/\boggi\b/i.test(clean)) {
        dayOffset = 0;
        dayWord = 'Oggi';
        matchedTimePhrases.push('oggi');
      }

      if (/\bmattina\b/i.test(clean)) matchedTimePhrases.push('mattina');
      if (/\bpomeriggio\b/i.test(clean)) matchedTimePhrases.push('pomeriggio');
      if (/\bsera\b/i.test(clean)) matchedTimePhrases.push('sera');
      if (/\bnotte\b/i.test(clean)) matchedTimePhrases.push('notte');

      const timeRegex = /\b(?:alle|ore)\s+(\d{1,2})(?::(\d{2})|\s*e\s*(mezza|quarto|tre\s*quarti|\d{1,2}))?\b/i;
      const mTime = clean.match(timeRegex);

      if (mTime) {
        matchedTimePhrases.push(mTime[0]);
        let hour = parseInt(mTime[1], 10);
        let minute = 0;

        if (mTime[2]) {
          minute = parseInt(mTime[2], 10);
        } else if (mTime[3]) {
          const w = mTime[3].toLowerCase();
          if (w.indexOf('mezz') !== -1) minute = 30;
          else if (w.indexOf('tre') !== -1) minute = 45;
          else if (w.indexOf('quart') !== -1) minute = 15;
          else if (!isNaN(parseInt(w, 10))) minute = parseInt(w, 10);
        }

        if (clean.toLowerCase().indexOf('pomeriggio') !== -1 && hour < 12) {
          hour += 12;
        } else if (clean.toLowerCase().indexOf('sera') !== -1 && hour < 12) {
          hour += 12;
        } else if (hour < 8 && clean.toLowerCase().indexOf('mattina') === -1) {
          hour += 12;
        }

        if (dayOffset === null) {
          const isPassedToday = (hour < now.getHours()) || (hour === now.getHours() && minute <= now.getMinutes());
          dayOffset = isPassedToday ? 1 : 0;
          dayWord = (dayOffset === 0) ? 'Oggi' : 'Domani';
        }

        const target = new Date(now.getTime());
        target.setDate(target.getDate() + dayOffset);
        target.setHours(hour, minute, 0, 0);
        startDate = target;

        const hhStr = String(hour).padStart(2, '0');
        const mmStr = String(minute).padStart(2, '0');
        humanDate = `${dayWord || 'Data'} alle ${hhStr}:${mmStr}`;
      }
    }

    // 4. Pattern C: Fallback predefinito se non viene specificato un orario
    if (!startDate) {
      if (now.getHours() < 20) {
        startDate = new Date(now.getTime() + 60 * 60 * 1000);
        startDate.setMinutes(0, 0, 0);
        const hhStr = String(startDate.getHours()).padStart(2, '0');
        humanDate = `Oggi alle ${hhStr}:00`;
      } else {
        const tomorrow = new Date(now.getTime());
        tomorrow.setDate(tomorrow.getDate() + 1);
        tomorrow.setHours(9, 0, 0, 0);
        startDate = tomorrow;
        humanDate = `Domani alle 09:00`;
      }
    }

    // 5. Durata evento: 30 minuti
    const endDate = new Date(startDate.getTime() + 30 * 60 * 1000);

    // 6. Pulizia del titolo
    let title = clean;
    matchedTimePhrases.forEach((phrase) => {
      phrase.split(/\s+/).forEach((word) => {
        if (word.length >= 2) {
          const reg = new RegExp('\\b' + word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\b', 'gi');
          title = title.replace(reg, '');
        }
      });
    });

    title = deduplicateTranscript(title)
      .replace(/\s{2,}/g, ' ')
      .replace(/^(?:di|per|a|che)\s+/i, '')
      .replace(/\s+(?:di|per|a|che)$/i, '')
      .trim();

    if (!title || title.length < 2) {
      title = 'Promemoria Mr.Duck';
    } else {
      title = title.charAt(0).toUpperCase() + title.slice(1);
    }

    return {
      title,
      startDate,
      endDate,
      humanDate
    };
  }

  /**
   * Genera e apre l'evento nel calendario dello smartphone (Google Calendar o Apple Calendar .ics)
   * @param {string} title Titolo del promemoria
   * @param {Date} startDate Data di inizio
   * @param {Date} endDate Data di fine (30 minuti dopo)
   * @param {string} targetService 'auto' | 'google' | 'apple' | 'none'
   */
  function openCalendarEvent(title, startDate, endDate, targetService = 'auto') {
    const cleanTitle = (title || 'Promemoria Mr.Duck').trim();
    const isoStart = formatGCalDate(startDate);
    const isoEnd = formatGCalDate(endDate);
    const dtstamp = formatGCalDate(new Date());
    const uid = `${Date.now()}-mrduck@carminellolab.com`;

    // 1. Google Calendar Universal Link
    const gcalUrl = `https://calendar.google.com/calendar/render?action=TEMPLATE&text=${encodeURIComponent('🦆 ' + cleanTitle)}&dates=${isoStart}/${isoEnd}&details=${encodeURIComponent('Promemoria impostato via Mr.Duck NFC')}`;

    // 2. File standard iCalendar (.ics) RFC 5545 con allarme notifica 10 minuti prima
    const icsContent = [
      'BEGIN:VCALENDAR',
      'VERSION:2.0',
      'PRODID:-//CarminelloLab//MrDuck WebAR//IT',
      'CALSCALE:GREGORIAN',
      'METHOD:PUBLISH',
      'BEGIN:VEVENT',
      `UID:${uid}`,
      `DTSTAMP:${dtstamp}`,
      `DTSTART:${isoStart}`,
      `DTEND:${isoEnd}`,
      `SUMMARY:🦆 ${cleanTitle}`,
      'DESCRIPTION:Promemoria impostato via Mr.Duck NFC',
      'STATUS:CONFIRMED',
      'BEGIN:VALARM',
      'ACTION:DISPLAY',
      `DESCRIPTION:Promemoria: ${cleanTitle}`,
      'TRIGGER:-PT10M',
      'END:VALARM',
      'END:VEVENT',
      'END:VCALENDAR'
    ].join('\r\n');

    const icsDataUri = 'data:text/calendar;charset=utf-8,' + encodeURIComponent(icsContent);

    if (targetService === 'none') {
      return { gcalUrl, icsContent, icsDataUri };
    }

    // 3. Rilevamento piattaforma
    const ua = navigator.userAgent || '';
    const isIOS = /iPad|iPhone|iPod/.test(ua) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
    const isAndroid = /Android/i.test(ua);
    const isChrome = /Chrome/i.test(ua) && !isIOS;

    if (targetService === 'google' || (targetService === 'auto' && (isAndroid || isChrome))) {
      // Se su Android/Chrome: apre direttamente il link universale di Google Calendar precompilato
      const opened = window.open(gcalUrl, '_blank');
      if (!opened || opened.closed || typeof opened.closed === 'undefined') {
        window.location.href = gcalUrl;
      }
    } else {
      // Se su iOS/Safari o desktop: genera e scarica al volo il file .ics
      triggerBlobDownload(icsContent, cleanTitle);
      if (isIOS) {
        setTimeout(() => {
          try {
            window.location.href = icsDataUri;
          } catch (e) {}
        }, 120);
      }
    }

    return { gcalUrl, icsContent, icsDataUri };
  }

  function triggerBlobDownload(icsContent, title) {
    try {
      const blob = new Blob([icsContent], { type: 'text/calendar;charset=utf-8' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      const safeFilename = (title || 'promemoria').toLowerCase().replace(/[^a-z0-9]/g, '-') || 'promemoria';
      a.download = `mrduck-${safeFilename}.ics`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      setTimeout(() => URL.revokeObjectURL(url), 3000);
    } catch (e) {
      console.warn('Download Blob fallito:', e);
    }
  }

  window.formatGCalDate = formatGCalDate;
  window.deduplicateTranscript = deduplicateTranscript;
  window.parseReminderText = parseReminderText;
  window.openCalendarEvent = openCalendarEvent;

  // =========================================================================
  // 1. CONFIGURAZIONE E COSTANTI GLOBALI
  // =========================================================================
  const CONFIG = {
    instagramUrl: "https://instagram.com/carminellolab_2.0",
    tiktokUrl: "https://www.tiktok.com/@carminellolab",

    colors: {
      duckYellow: 0xFFE600,
      duckGold: 0xFFD700,
      duckBeak: 0xFF6B00,
      duckCheek: 0xFF6B8B,
      duckTongue: 0xFF2A55,
      feetOrange: 0xFF7A00,
      pureWhite: 0xFFFFFF,
      pureBlack: 0x0A0A0E,

      walnutWood: 0x5C2E0E,
      darkWood: 0x381B08,
      bluedSteel: 0x242830,
      engravedSteel: 0x9096A2,
      brassGold: 0xD4AF37,
      boreBlack: 0x08080A
    }
  };

  // Configurazione progressione ondate (Wave Survival)
  const WAVE_CONFIG = [
    {
      level: 1,
      name: "TUTORIAL: VOLO BASE",
      duckCount: 6,
      weapon: 'none',
      canAttack: false,
      attackType: 'none',
      speed: 1.0,
      damage: 0,
      description: "Paperelle passive in volo d'esplorazione."
    },
    {
      level: 2,
      name: "BECCATA CQC (CORPO A CORPO)",
      duckCount: 8,
      weapon: 'beak',
      canAttack: true,
      attackType: 'dive',
      speed: 2.0,
      damage: 10,
      attackCooldownMin: 4.0,
      attackCooldownMax: 7.0,
      description: "Attacco in picchiata: infliggono 10 HP di danno!"
    },
    {
      level: 3,
      name: "PAPERELLE CON COLTELLO",
      duckCount: 10,
      weapon: 'knife',
      canAttack: true,
      attackType: 'knife_zigzag',
      speed: 2.7,
      damage: 20,
      attackCooldownMin: 3.5,
      attackCooldownMax: 6.0,
      description: "Scatti a zigzag con lama affilata: 20 HP di danno!"
    },
    {
      level: 4,
      name: "PAPERELLE CON PISTOLA",
      duckCount: 12,
      weapon: 'pistol',
      canAttack: true,
      attackType: 'shoot_bullet',
      speed: 1.2,
      damage: 15,
      projectileSpeed: 4.0,
      attackCooldownMin: 3.0,
      attackCooldownMax: 5.5,
      description: "Tiratori a distanza: proiettili da 15 HP (intercettabili)!"
    },
    {
      level: 5,
      name: "PAPERELLE CON RPG (BAZOOKA)",
      duckCount: 14,
      weapon: 'rpg',
      canAttack: true,
      attackType: 'shoot_rocket',
      speed: 1.0,
      damage: 45,
      projectileSpeed: 2.3,
      attackCooldownMin: 4.0,
      attackCooldownMax: 6.5,
      description: "Razzi esplosivi pesanti da 45 HP: distruggili al volo!"
    }
  ];

  const TARGET_OBJECTS = {
    chair: 'SEDIA',
    couch: 'DIVANO',
    bottle: 'BOTTIGLIA',
    cup: 'TAZZA',
    laptop: 'PORTATILE',
    tv: 'SCHERMO TV',
    'cell phone': 'SMARTPHONE',
    person: 'PERSONA',
    'potted plant': 'PIANTA',
    book: 'LIBRO',
    table: 'TAVOLO',
    'dining table': 'TAVOLO',
    backpack: 'ZAINO',
    keyboard: 'TASTIERA',
    mouse: 'MOUSE',
    vase: 'VASO'
  };

  const GAME_STATE = {
    isPlaying: false,
    soundEnabled: true,
    score: 0,
    level: 1,
    hp: 100,
    maxHp: 100,
    totalDamageTaken: 0,
    ducksHit: 0,
    totalShots: 0,
    combo: 1,
    comboTimer: 0,
    isContactsMode: false,

    hasGyro: false,
    gyroActive: false,
    gyroAlpha: 0,
    gyroBeta: 0,
    gyroGamma: 0,
    screenOrientation: 0,
    yawOffset: 0,

    lastFireTime: 0
  };

  const DOM = {
    container: document.querySelector('#ar-container'),
    cameraFeed: document.querySelector('#camera-feed'),
    startOverlay: document.querySelector('#start-overlay'),
    btnStartGame: document.querySelector('#btn-start-game'),
    gameOverOverlay: document.querySelector('#game-over-overlay'),

    // Floating Glassmorphism Bottom Dock DOM elements
    bottomDock: document.querySelector('#bottom-dock'),
    btnDockMrduck: document.querySelector('#btn-dock-mrduck'),
    btnDockContacts: document.querySelector('#btn-dock-contacts'),

    contactsHud: document.querySelector('#contacts-hud'),
    btnCloseContacts: document.querySelector('#btn-close-contacts'),
    boxButtonInstagram: document.querySelector('#box-button-instagram'),
    boxButtonTiktok: document.querySelector('#box-button-tiktok'),
    btnPlayAgain: document.querySelector('#btn-play-again'),
    btnGameOverMenu: document.querySelector('#btn-game-over-menu'),
    btnFire: document.querySelector('#btn-fire'),
    btnAudio: document.querySelector('#btn-audio'),
    btnRecenter: document.querySelector('#btn-recenter'),
    btnExitGame: document.querySelector('#btn-exit-game'),
    iconSoundOn: document.querySelector('#icon-sound-on'),
    iconSoundOff: document.querySelector('#icon-sound-off'),

    // Leaderboard & Arcade Hall of Fame DOM elements
    btnViewLeaderboard: document.querySelector('#btn-view-leaderboard'),
    btnStartLeaderboard: document.querySelector('#btn-start-leaderboard'),
    leaderboardOverlay: document.querySelector('#leaderboard-overlay'),
    leaderboardTableBody: document.querySelector('#leaderboard-table-body'),
    btnCloseLeaderboard: document.querySelector('#btn-close-leaderboard'),
    arcadeRegisterBox: document.querySelector('#arcade-register-box'),
    arcadeInputName: document.querySelector('#arcade-input-name'),
    btnSaveScore: document.querySelector('#btn-save-score'),
    arcadeSaveFeedback: document.querySelector('#arcade-save-feedback'),

    // Mr.Duck Assistant Voice DOM elements
    mrduckModal: document.querySelector('#mrduck-modal'),
    btnCloseMrduck: document.querySelector('#btn-close-mrduck'),
    mrduckMicBtn: document.querySelector('#mrduck-mic-btn'),
    mrduckStatus: document.querySelector('#mrduck-status'),
    mrduckTranscript: document.querySelector('#mrduck-transcript'),
    mrduckReplyBox: document.querySelector('#mrduck-reply-box'),
    mrduckReplyText: document.querySelector('#mrduck-reply-text'),
    mrduckReminderCard: document.querySelector('#mrduck-reminder-card'),
    mrduckParsedDate: document.querySelector('#mrduck-parsed-date'),
    mrduckParsedTitle: document.querySelector('#mrduck-parsed-title'),
    btnMrduckCalendar: document.querySelector('#btn-mrduck-calendar'),
    mrduckCalBtnText: document.querySelector('#mrduck-cal-btn-text'),
    mrduckCalChoices: document.querySelector('#mrduck-cal-choices'),
    btnMrduckGcal: document.querySelector('#btn-mrduck-gcal'),
    btnMrduckApple: document.querySelector('#btn-mrduck-apple'),
    btnMrduckDone: document.querySelector('#btn-mrduck-done'),
    btnMrduckRetry: document.querySelector('#btn-mrduck-retry'),

    gameStatsBar: document.querySelector('#game-stats-bar'),
    hudBottom: document.querySelector('#hud-bottom'),
    crosshair: document.querySelector('#crosshair'),
    crosshairHitmarker: document.querySelector('#crosshair-hitmarker'),
    crosshairLockLabel: document.querySelector('#crosshair-lock-label'),
    muzzleFlash: document.querySelector('#muzzle-flash'),
    damageFlash: document.querySelector('#damage-flash'),
    hitVignette: document.querySelector('#hit-vignette'),
    waveBanner: document.querySelector('#wave-banner'),
    waveBannerTitle: document.querySelector('#wave-banner-title'),
    waveBannerSub: document.querySelector('#wave-banner-sub'),
    floatingScoresContainer: document.querySelector('#floating-scores-container'),
    radarContainer: document.querySelector('#radar-container'),
    radarBlips: document.querySelector('#radar-blips'),
    hudObjectAlert: document.querySelector('#hud-object-alert'),
    hudObjectText: document.querySelector('#hud-object-text'),

    statScoreVal: document.querySelector('#stat-score-val'),
    statLevelVal: document.querySelector('#stat-level-val'),
    statHpText: document.querySelector('#stat-hp-text'),
    hpBarFill: document.querySelector('#hp-bar-fill'),
    statDucksVal: document.querySelector('#stat-ducks-val'),
    statComboVal: document.querySelector('#stat-combo-val'),

    finalScore: document.querySelector('#final-score'),
    finalLevel: document.querySelector('#final-level'),
    finalDucks: document.querySelector('#final-ducks'),
    finalDamage: document.querySelector('#final-damage'),
    gameOverTitle: document.querySelector('#game-over-title'),
    gameOverSubtitle: document.querySelector('#game-over-subtitle'),
    gameOverBadge: document.querySelector('#game-over-badge')
  };

  // =========================================================================
  // 2. VARIABILI DI SCRATCH PRE-ALLOCATE (ZERO GC ALLOCATION)
  // =========================================================================
  const _v1 = new THREE.Vector3();
  const _v2 = new THREE.Vector3();
  const _v3 = new THREE.Vector3();
  const _q1 = new THREE.Quaternion();
  const _q2 = new THREE.Quaternion();
  const _euler = new THREE.Euler(0, 0, 0, 'YXZ');
  const _mat4 = new THREE.Matrix4();
  const _screenCenter = new THREE.Vector2(0, 0);
  const _radarForward = new THREE.Vector3();

  // =========================================================================
  // 3. MOTORE AUDIO PROCEDURALE (Web Audio API)
  // =========================================================================
  class AudioEngine {
    constructor() {
      this.ctx = null;
    }

    init() {
      try {
        const AudioCtx = window.AudioContext || window.webkitAudioContext;
        if (AudioCtx && !this.ctx) {
          this.ctx = new AudioCtx();
        }
        if (this.ctx && this.ctx.state === 'suspended') {
          this.ctx.resume();
        }
      } catch (e) {
        console.warn('AudioContext init error:', e);
      }
    }

    vibrate(pattern = [35]) {
      try {
        if (navigator.vibrate) {
          navigator.vibrate(pattern);
        }
      } catch (e) {}
    }

    playShotgun() {
      this.vibrate([70, 30, 80]);
      if (!GAME_STATE.soundEnabled || !this.ctx) return;
      try {
        const now = this.ctx.currentTime;

        // Cinetica Shotgun FPS: Sawtooth con calo rapido (800Hz -> 80Hz in 0.08s)
        const sawOsc = this.ctx.createOscillator();
        const sawGain = this.ctx.createGain();
        sawOsc.type = 'sawtooth';
        sawOsc.frequency.setValueAtTime(800, now);
        sawOsc.frequency.exponentialRampToValueAtTime(80, now + 0.08);

        sawGain.gain.setValueAtTime(0.75, now);
        sawGain.gain.exponentialRampToValueAtTime(0.001, now + 0.08);

        sawOsc.connect(sawGain);
        sawGain.connect(this.ctx.destination);
        sawOsc.start(now);
        sawOsc.stop(now + 0.085);

        // Punchy Noise Body per impatto esplosivo
        const bufferSize = Math.floor(this.ctx.sampleRate * 0.12);
        const noiseBuffer = this.ctx.createBuffer(1, bufferSize, this.ctx.sampleRate);
        const output = noiseBuffer.getChannelData(0);
        for (let i = 0; i < bufferSize; i++) {
          output[i] = Math.random() * 2 - 1;
        }
        const whiteNoise = this.ctx.createBufferSource();
        whiteNoise.buffer = noiseBuffer;

        const noiseFilter = this.ctx.createBiquadFilter();
        noiseFilter.type = 'lowpass';
        noiseFilter.frequency.setValueAtTime(2400, now);
        noiseFilter.frequency.exponentialRampToValueAtTime(100, now + 0.12);

        const noiseGain = this.ctx.createGain();
        noiseGain.gain.setValueAtTime(0.7, now);
        noiseGain.gain.exponentialRampToValueAtTime(0.001, now + 0.12);

        whiteNoise.connect(noiseFilter);
        noiseFilter.connect(noiseGain);
        noiseGain.connect(this.ctx.destination);
        whiteNoise.start(now);
      } catch (e) {}
    }

    /**
     * Feedback Acustico Hitmarker (Sine Beep ad alta frequenza 2000Hz, 0.04s)
     */
    playHitmarker(isCrit = false) {
      this.vibrate(isCrit ? [35, 20, 50] : [25]);
      if (!GAME_STATE.soundEnabled || !this.ctx) return;
      try {
        const now = this.ctx.currentTime;
        const osc = this.ctx.createOscillator();
        const gain = this.ctx.createGain();
        osc.type = 'sine';
        const freq = isCrit ? 2600 : 2000;
        osc.frequency.setValueAtTime(freq, now);

        gain.gain.setValueAtTime(0.38, now);
        gain.gain.exponentialRampToValueAtTime(0.001, now + 0.04);

        osc.connect(gain);
        gain.connect(this.ctx.destination);
        osc.start(now);
        osc.stop(now + 0.045);
      } catch (e) {}
    }

    /**
     * Suono di caduta / sconfitta anatra (Sequenza comica discendente)
     */
    playDuckFall() {
      if (!GAME_STATE.soundEnabled || !this.ctx) return;
      try {
        const now = this.ctx.currentTime;
        const osc = this.ctx.createOscillator();
        const gain = this.ctx.createGain();
        osc.type = 'triangle';
        osc.frequency.setValueAtTime(750, now);
        osc.frequency.exponentialRampToValueAtTime(120, now + 0.32);

        gain.gain.setValueAtTime(0.28, now);
        gain.gain.linearRampToValueAtTime(0.32, now + 0.08);
        gain.gain.exponentialRampToValueAtTime(0.001, now + 0.32);

        osc.connect(gain);
        gain.connect(this.ctx.destination);
        osc.start(now);
        osc.stop(now + 0.33);
      } catch (e) {}
    }

    playQuack(isGold = false, isPerch = false) {
      this.vibrate(isPerch ? [60, 40, 80] : [45, 30, 65]);
      if (!GAME_STATE.soundEnabled || !this.ctx) return;
      try {
        const now = this.ctx.currentTime;
        const dur = isGold ? 0.35 : (isPerch ? 0.38 : 0.24);
        const baseFreq = isGold ? 580 : (isPerch ? 520 : 450);

        const osc = this.ctx.createOscillator();
        osc.type = 'sawtooth';
        osc.frequency.setValueAtTime(baseFreq * 0.75, now);
        osc.frequency.exponentialRampToValueAtTime(baseFreq * 2.4, now + 0.05);
        osc.frequency.exponentialRampToValueAtTime(baseFreq * 0.85, now + dur);

        const filter = this.ctx.createBiquadFilter();
        filter.type = 'bandpass';
        filter.Q.value = 8.0;
        filter.frequency.setValueAtTime(isGold ? 1900 : 1650, now);
        filter.frequency.exponentialRampToValueAtTime(750, now + dur);

        const gain = this.ctx.createGain();
        gain.gain.setValueAtTime(0.001, now);
        gain.gain.linearRampToValueAtTime(0.26, now + 0.02);
        gain.gain.exponentialRampToValueAtTime(0.0001, now + dur);

        osc.connect(filter);
        filter.connect(gain);
        gain.connect(this.ctx.destination);
        osc.start(now);
        osc.stop(now + dur);
      } catch (e) {}
    }

    playPlayerHit() {
      this.vibrate([100, 50, 120]);
      if (!GAME_STATE.soundEnabled || !this.ctx) return;
      try {
        const now = this.ctx.currentTime;
        const osc = this.ctx.createOscillator();
        const gain = this.ctx.createGain();
        osc.type = 'sawtooth';
        osc.frequency.setValueAtTime(190, now);
        osc.frequency.exponentialRampToValueAtTime(45, now + 0.25);
        gain.gain.setValueAtTime(0.75, now);
        gain.gain.exponentialRampToValueAtTime(0.001, now + 0.25);
        osc.connect(gain);
        gain.connect(this.ctx.destination);
        osc.start(now);
        osc.stop(now + 0.25);
      } catch (e) {}
    }

    playWaveSuccess() {
      this.vibrate([60, 40, 90]);
      if (!GAME_STATE.soundEnabled || !this.ctx) return;
      try {
        const notes = [440, 554, 659, 880];
        notes.forEach((freq, idx) => {
          const t = this.ctx.currentTime + idx * 0.08;
          const osc = this.ctx.createOscillator();
          const gain = this.ctx.createGain();
          osc.type = 'triangle';
          osc.frequency.setValueAtTime(freq, t);
          gain.gain.setValueAtTime(0.32, t);
          gain.gain.exponentialRampToValueAtTime(0.001, t + 0.2);
          osc.connect(gain);
          gain.connect(this.ctx.destination);
          osc.start(t);
          osc.stop(t + 0.2);
        });
      } catch (e) {}
    }

    playRocketExplosion() {
      this.vibrate([120, 60, 150]);
      if (!GAME_STATE.soundEnabled || !this.ctx) return;
      try {
        const now = this.ctx.currentTime;
        const osc = this.ctx.createOscillator();
        const gain = this.ctx.createGain();
        osc.type = 'square';
        osc.frequency.setValueAtTime(100, now);
        osc.frequency.exponentialRampToValueAtTime(22, now + 0.45);
        gain.gain.setValueAtTime(0.85, now);
        gain.gain.exponentialRampToValueAtTime(0.001, now + 0.45);
        osc.connect(gain);
        gain.connect(this.ctx.destination);
        osc.start(now);
        osc.stop(now + 0.45);
      } catch (e) {}
    }

    playArcadeCoin() {
      this.vibrate([35, 20, 45]);
      if (!GAME_STATE.soundEnabled || !this.ctx) return;
      try {
        const now = this.ctx.currentTime;
        const osc = this.ctx.createOscillator();
        const gain = this.ctx.createGain();
        osc.type = 'square';
        osc.frequency.setValueAtTime(987.77, now); // B5
        osc.frequency.setValueAtTime(1318.51, now + 0.08); // E6
        gain.gain.setValueAtTime(0.12, now);
        gain.gain.exponentialRampToValueAtTime(0.001, now + 0.35);
        osc.connect(gain);
        gain.connect(this.ctx.destination);
        osc.start(now);
        osc.stop(now + 0.36);
      } catch (e) {}
    }

    playHighscoreFanfare() {
      this.vibrate([60, 40, 60, 40, 100]);
      if (!GAME_STATE.soundEnabled || !this.ctx) return;
      try {
        const now = this.ctx.currentTime;
        const notes = [
          { f: 523.25, t: 0.00 }, // C5
          { f: 659.25, t: 0.09 }, // E5
          { f: 783.99, t: 0.18 }, // G5
          { f: 1046.50, t: 0.29 } // C6
        ];
        notes.forEach(n => {
          const osc = this.ctx.createOscillator();
          const gain = this.ctx.createGain();
          osc.type = 'triangle';
          osc.frequency.setValueAtTime(n.f, now + n.t);
          gain.gain.setValueAtTime(0.18, now + n.t);
          gain.gain.exponentialRampToValueAtTime(0.001, now + n.t + 0.22);
          osc.connect(gain);
          gain.connect(this.ctx.destination);
          osc.start(now + n.t);
          osc.stop(now + n.t + 0.23);
        });
      } catch (e) {}
    }

    playDefeatSound() {
      this.vibrate([160, 80, 200, 100, 240]);
      if (!GAME_STATE.soundEnabled || !this.ctx) return;
      try {
        const now = this.ctx.currentTime;
        const notes = [
          { f: 293.66, t: 0.00 }, // D4
          { f: 277.18, t: 0.16 }, // C#4
          { f: 261.63, t: 0.32 }, // C4
          { f: 207.65, t: 0.48 }  // G#3 (retro defeat tone)
        ];
        notes.forEach(n => {
          const osc = this.ctx.createOscillator();
          const gain = this.ctx.createGain();
          osc.type = 'sawtooth';
          osc.frequency.setValueAtTime(n.f, now + n.t);
          gain.gain.setValueAtTime(0.28, now + n.t);
          gain.gain.exponentialRampToValueAtTime(0.001, now + n.t + 0.32);
          osc.connect(gain);
          gain.connect(this.ctx.destination);
          osc.start(now + n.t);
          osc.stop(now + n.t + 0.35);
        });
      } catch (e) {}
    }
  }

  const audio = new AudioEngine();

  // =========================================================================
  // 3.1 CLASSIFICA ARCADE ANNI '90 (LOCALSTORAGE & HALL OF FAME)
  // =========================================================================
  const LEADERBOARD_STORAGE_KEY = 'carminello_duckhunt_leaderboard_v1';
  const DEFAULT_LEADERBOARD = [
    { name: "CAR", score: 4850, level: 7, ducks: 42, date: "RECORD" },
    { name: "LAB", score: 3900, level: 6, ducks: 35, date: "RECORD" },
    { name: "ACE", score: 2950, level: 5, ducks: 28, date: "RECORD" },
    { name: "DUK", score: 2100, level: 4, ducks: 21, date: "RECORD" },
    { name: "90S", score: 1450, level: 3, ducks: 15, date: "RECORD" },
    { name: "MAX", score: 980,  level: 2, ducks: 10, date: "RECORD" },
    { name: "FLY", score: 650,  level: 2, ducks: 7,  date: "RECORD" },
    { name: "FOX", score: 420,  level: 1, ducks: 5,  date: "RECORD" }
  ];

  function escapeHtml(str) {
    if (!str) return '';
    return String(str)
      .replaceAll('&', '&amp;')
      .replaceAll('<', '&lt;')
      .replaceAll('>', '&gt;')
      .replaceAll('"', '&quot;')
      .replaceAll("'", '&#39;');
  }

  class LeaderboardManager {
    constructor() {
      this.lastSavedId = null;
    }

    getScores() {
      try {
        const raw = localStorage.getItem(LEADERBOARD_STORAGE_KEY);
        if (raw) {
          const parsed = JSON.parse(raw);
          if (Array.isArray(parsed) && parsed.length > 0) {
            return parsed;
          }
        }
      } catch (e) {
        console.warn('Leaderboard parse error:', e);
      }
      return [...DEFAULT_LEADERBOARD];
    }

    saveScores(list) {
      try {
        localStorage.setItem(LEADERBOARD_STORAGE_KEY, JSON.stringify(list));
      } catch (e) {
        console.warn('Leaderboard write error:', e);
      }
    }

    resetScores() {
      this.saveScores([...DEFAULT_LEADERBOARD]);
      this.lastSavedId = null;
    }

    addScore(name, score, level, ducks) {
      const cleanName = (name || 'AAA').trim().toUpperCase().slice(0, 5) || 'AAA';
      const scores = this.getScores();
      const newId = Date.now();
      const newEntry = {
        id: newId,
        name: cleanName,
        score: Math.max(0, parseInt(score, 10) || 0),
        level: Math.max(1, parseInt(level, 10) || 1),
        ducks: Math.max(0, parseInt(ducks, 10) || 0),
        date: new Date().toLocaleDateString('it-IT', { day: '2-digit', month: '2-digit' })
      };

      scores.push(newEntry);
      scores.sort((a, b) => {
        if (b.score !== a.score) return b.score - a.score;
        if (b.level !== a.level) return b.level - a.level;
        return b.ducks - a.ducks;
      });

      const top10 = scores.slice(0, 10);
      this.saveScores(top10);
      this.lastSavedId = newId;

      try {
        localStorage.setItem('duckhunt_last_player_name', cleanName);
      } catch (e) {}

      const rankIndex = top10.findIndex(item => item.id === newId);
      return {
        rank: rankIndex >= 0 ? rankIndex + 1 : null,
        entry: newEntry,
        list: top10
      };
    }

    render(containerEl, highlightedId = this.lastSavedId) {
      if (!containerEl) return;
      const scores = this.getScores();
      containerEl.innerHTML = '';

      scores.forEach((entry, idx) => {
        const rank = idx + 1;
        const tr = document.createElement('tr');
        tr.className = `arcade-lb-row rank-${rank}`;
        if (entry.id && entry.id === highlightedId) {
          tr.classList.add('row-highlight');
        }

        let medalBadge = `#${rank}`;
        if (rank === 1) medalBadge = '🥇 #1';
        else if (rank === 2) medalBadge = '🥈 #2';
        else if (rank === 3) medalBadge = '🥉 #3';

        tr.innerHTML = `
          <td class="col-rank">${medalBadge}</td>
          <td class="col-name"><span class="player-tag">${escapeHtml(entry.name)}</span></td>
          <td class="col-level">W${entry.level}</td>
          <td class="col-score">${entry.score.toLocaleString('it-IT')}</td>
          <td class="col-ducks">${entry.ducks}</td>
        `;
        containerEl.appendChild(tr);
      });
    }
  }

  // =========================================================================
  // 4. CACHE CONDIVISA GEOMETRIE & MATERIALI
  // =========================================================================
  let SHARED_ASSETS = null;

  function initSharedAssets(THREE) {
    if (SHARED_ASSETS) return SHARED_ASSETS;

    const duckYellowMat = new THREE.MeshStandardMaterial({
      color: CONFIG.colors.duckYellow,
      roughness: 0.35,
      metalness: 0.1,
      emissive: 0x241D00,
      emissiveIntensity: 0.15
    });

    const duckGoldMat = new THREE.MeshStandardMaterial({
      color: CONFIG.colors.duckGold,
      roughness: 0.28,
      metalness: 0.35,
      emissive: 0x382A00,
      emissiveIntensity: 0.22
    });

    const beakMat = new THREE.MeshStandardMaterial({
      color: CONFIG.colors.duckBeak,
      roughness: 0.35,
      metalness: 0.05,
      emissive: 0x1A0A00,
      emissiveIntensity: 0.1
    });

    const cheekMat = new THREE.MeshStandardMaterial({
      color: CONFIG.colors.duckCheek,
      roughness: 0.45,
      metalness: 0.0
    });

    const tongueMat = new THREE.MeshStandardMaterial({
      color: CONFIG.colors.duckTongue,
      roughness: 0.3,
      metalness: 0.05
    });

    const eyeWhiteMat = new THREE.MeshStandardMaterial({
      color: CONFIG.colors.pureWhite,
      roughness: 0.2,
      metalness: 0.05
    });

    const eyePupilMat = new THREE.MeshStandardMaterial({
      color: CONFIG.colors.pureBlack,
      roughness: 0.1,
      metalness: 0.15
    });

    const feetMat = new THREE.MeshStandardMaterial({
      color: CONFIG.colors.feetOrange,
      roughness: 0.4,
      metalness: 0.05
    });

    const sunglassesMat = new THREE.MeshStandardMaterial({
      color: 0x111116,
      roughness: 0.15,
      metalness: 0.75
    });

    const crownMat = new THREE.MeshStandardMaterial({
      color: 0xFFD700,
      roughness: 0.25,
      metalness: 0.65
    });

    const crownGemMat = new THREE.MeshStandardMaterial({
      color: 0xFF0055,
      roughness: 0.15,
      metalness: 0.2,
      emissive: 0x440011,
      emissiveIntensity: 0.4
    });

    // Materiali Armi & Militari
    const bluedSteelMat = new THREE.MeshStandardMaterial({
      color: CONFIG.colors.bluedSteel,
      metalness: 0.88,
      roughness: 0.24
    });

    const shinySteelMat = new THREE.MeshStandardMaterial({
      color: 0xEEEEF2,
      metalness: 0.95,
      roughness: 0.12
    });

    const militaryGreenMat = new THREE.MeshStandardMaterial({
      color: 0x384B2F,
      metalness: 0.2,
      roughness: 0.65
    });

    const rocketRedMat = new THREE.MeshStandardMaterial({
      color: 0xD62200,
      emissive: 0x880000,
      emissiveIntensity: 0.6,
      roughness: 0.25
    });

    const receiverSteelMat = new THREE.MeshStandardMaterial({
      color: CONFIG.colors.engravedSteel,
      metalness: 0.85,
      roughness: 0.30
    });

    const walnutWoodMat = new THREE.MeshStandardMaterial({
      color: CONFIG.colors.walnutWood,
      metalness: 0.05,
      roughness: 0.45
    });

    const darkWoodMat = new THREE.MeshStandardMaterial({
      color: CONFIG.colors.darkWood,
      metalness: 0.05,
      roughness: 0.50
    });

    const brassMat = new THREE.MeshStandardMaterial({
      color: CONFIG.colors.brassGold,
      metalness: 0.90,
      roughness: 0.20
    });

    const boreMat = new THREE.MeshStandardMaterial({
      color: CONFIG.colors.boreBlack,
      metalness: 0.1,
      roughness: 0.95
    });

    // Geometrie
    const bodyGeom = new THREE.SphereGeometry(0.36, 16, 16);
    bodyGeom.scale(1.05, 0.95, 1.25);

    const headGeom = new THREE.SphereGeometry(0.25, 16, 16);

    const featherGeom1 = new THREE.ConeGeometry(0.035, 0.16, 8);
    featherGeom1.rotateZ(0.25);
    const featherGeom2 = new THREE.ConeGeometry(0.03, 0.13, 8);
    featherGeom2.rotateZ(-0.35);
    featherGeom2.rotateX(-0.15);

    const cheekGeom = new THREE.SphereGeometry(0.05, 8, 8);
    cheekGeom.scale(1.0, 0.6, 0.4);

    const eyeGeom = new THREE.SphereGeometry(0.08, 12, 12);
    eyeGeom.scale(0.85, 1.1, 0.85);

    const pupilGeom = new THREE.SphereGeometry(0.042, 8, 8);
    const glintBigGeom = new THREE.SphereGeometry(0.016, 6, 6);

    const upperBillGeom = new THREE.ConeGeometry(0.13, 0.25, 12);
    upperBillGeom.scale(1.5, 0.36, 1.0);
    upperBillGeom.rotateX(Math.PI / 2);

    const lowerBillGeom = new THREE.ConeGeometry(0.11, 0.20, 12);
    lowerBillGeom.scale(1.4, 0.28, 1.0);
    lowerBillGeom.rotateX(Math.PI / 2 + 0.18);

    const tongueGeom = new THREE.SphereGeometry(0.045, 6, 6);
    tongueGeom.scale(1.2, 0.4, 1.6);

    const tailGeom = new THREE.ConeGeometry(0.12, 0.28, 8);
    tailGeom.rotateX(-Math.PI / 3.0);

    const legGeom = new THREE.CylinderGeometry(0.015, 0.015, 0.16, 6);
    legGeom.rotateX(-Math.PI / 4.0);

    const footGeom = new THREE.ConeGeometry(0.065, 0.14, 6);
    footGeom.scale(1.6, 0.2, 1.0);
    footGeom.rotateX(Math.PI / 2);

    const wingGeom = new THREE.SphereGeometry(0.14, 10, 10);
    wingGeom.scale(1.8, 0.4, 1.0);

    const frameGeom = new THREE.BoxGeometry(0.34, 0.08, 0.04);
    const crownGeom = new THREE.CylinderGeometry(0.14, 0.09, 0.12, 5);
    const gemGeom = new THREE.SphereGeometry(0.025, 6, 6);

    const colliderGeom = new THREE.SphereGeometry(0.55, 8, 8);
    const colliderMat = new THREE.MeshBasicMaterial({ visible: false });

    SHARED_ASSETS = {
      mats: {
        duckYellowMat,
        duckGoldMat,
        beakMat,
        cheekMat,
        tongueMat,
        eyeWhiteMat,
        eyePupilMat,
        feetMat,
        sunglassesMat,
        crownMat,
        crownGemMat,
        bluedSteelMat,
        shinySteelMat,
        militaryGreenMat,
        rocketRedMat,
        receiverSteelMat,
        walnutWoodMat,
        darkWoodMat,
        brassMat,
        boreMat,
        colliderMat
      },
      geoms: {
        bodyGeom,
        headGeom,
        featherGeom1,
        featherGeom2,
        cheekGeom,
        eyeGeom,
        pupilGeom,
        glintBigGeom,
        upperBillGeom,
        lowerBillGeom,
        tongueGeom,
        tailGeom,
        legGeom,
        footGeom,
        wingGeom,
        frameGeom,
        crownGeom,
        gemGeom,
        colliderGeom
      }
    };

    return SHARED_ASSETS;
  }

  // =========================================================================
  // 5. COSTRUTTORI ASSET 3D & ARMI PAPERELLE
  // =========================================================================

  function createKnife3D(THREE) {
    const assets = initSharedAssets(THREE);
    const knife = new THREE.Group();

    // Lama
    const bladeGeom = new THREE.ConeGeometry(0.045, 0.22, 4);
    bladeGeom.scale(0.2, 1.0, 1.0);
    bladeGeom.rotateX(Math.PI / 2);
    const blade = new THREE.Mesh(bladeGeom, assets.mats.shinySteelMat);
    blade.position.set(0, 0, 0.12);
    knife.add(blade);

    // Guardia
    const guardGeom = new THREE.BoxGeometry(0.07, 0.015, 0.02);
    const guard = new THREE.Mesh(guardGeom, assets.mats.bluedSteelMat);
    guard.position.set(0, 0, 0.01);
    knife.add(guard);

    // Impugnatura
    const handleGeom = new THREE.BoxGeometry(0.035, 0.025, 0.09);
    const handle = new THREE.Mesh(handleGeom, assets.mats.darkWoodMat);
    handle.position.set(0, 0, -0.045);
    knife.add(handle);

    return knife;
  }

  function createPistol3D(THREE) {
    const assets = initSharedAssets(THREE);
    const pistol = new THREE.Group();

    // Carrello
    const slideGeom = new THREE.BoxGeometry(0.04, 0.048, 0.16);
    const slide = new THREE.Mesh(slideGeom, assets.mats.bluedSteelMat);
    slide.position.set(0, 0.02, 0.04);
    pistol.add(slide);

    // Canna
    const barrelGeom = new THREE.CylinderGeometry(0.014, 0.014, 0.05, 8);
    barrelGeom.rotateX(Math.PI / 2);
    const barrel = new THREE.Mesh(barrelGeom, assets.mats.shinySteelMat);
    barrel.position.set(0, 0.02, 0.14);
    pistol.add(barrel);

    // Impugnatura
    const gripGeom = new THREE.BoxGeometry(0.035, 0.09, 0.045);
    gripGeom.rotateX(-0.25);
    const grip = new THREE.Mesh(gripGeom, assets.mats.walnutWoodMat);
    grip.position.set(0, -0.04, -0.01);
    pistol.add(grip);

    return pistol;
  }

  function createBazooka3D(THREE) {
    const assets = initSharedAssets(THREE);
    const rpg = new THREE.Group();

    // Tubo di lancio
    const tubeGeom = new THREE.CylinderGeometry(0.042, 0.046, 0.48, 14);
    tubeGeom.rotateX(Math.PI / 2);
    const tube = new THREE.Mesh(tubeGeom, assets.mats.militaryGreenMat);
    rpg.add(tube);

    // Cono di scarico posteriore
    const exhaustGeom = new THREE.ConeGeometry(0.065, 0.09, 12);
    exhaustGeom.rotateX(-Math.PI / 2);
    const exhaust = new THREE.Mesh(exhaustGeom, assets.mats.bluedSteelMat);
    exhaust.position.set(0, 0, 0.25);
    rpg.add(exhaust);

    // Mirino ottico
    const scopeGeom = new THREE.BoxGeometry(0.02, 0.025, 0.14);
    const scope = new THREE.Mesh(scopeGeom, assets.mats.bluedSteelMat);
    scope.position.set(0, 0.055, -0.05);
    rpg.add(scope);

    // Razzo caricato in volata
    const rocketTipGeom = new THREE.ConeGeometry(0.045, 0.11, 12);
    rocketTipGeom.rotateX(Math.PI / 2);
    const rocketTip = new THREE.Mesh(rocketTipGeom, assets.mats.rocketRedMat);
    rocketTip.position.set(0, 0, -0.28);
    rpg.add(rocketTip);

    return rpg;
  }

  function createMilitaryHelmet(THREE) {
    const assets = initSharedAssets(THREE);
    const helmet = new THREE.Group();

    const domeGeom = new THREE.SphereGeometry(0.27, 14, 14);
    domeGeom.scale(1.08, 0.75, 1.15);
    const dome = new THREE.Mesh(domeGeom, assets.mats.militaryGreenMat);
    helmet.add(dome);

    const brimGeom = new THREE.TorusGeometry(0.27, 0.018, 6, 16);
    brimGeom.rotateX(Math.PI / 2);
    const brim = new THREE.Mesh(brimGeom, assets.mats.militaryGreenMat);
    brim.position.set(0, -0.05, 0);
    helmet.add(brim);

    return helmet;
  }

  /**
   * Modello Fucile da Caccia Classico FPV
   */
  function createClassicHuntingShotgun(THREE) {
    const assets = initSharedAssets(THREE);
    const { mats } = assets;
    const gunGroup = new THREE.Group();

    const barrelLength = 0.72;
    const barrelRadius = 0.016;
    const barrelSpacing = 0.034;

    const barrelGeom = new THREE.CylinderGeometry(barrelRadius * 0.92, barrelRadius, barrelLength, 20);
    barrelGeom.rotateX(Math.PI / 2);

    const leftBarrel = new THREE.Mesh(barrelGeom, mats.bluedSteelMat);
    leftBarrel.position.set(-barrelSpacing / 2, 0.01, -barrelLength / 2);
    gunGroup.add(leftBarrel);

    const rightBarrel = new THREE.Mesh(barrelGeom, mats.bluedSteelMat);
    rightBarrel.position.set(barrelSpacing / 2, 0.01, -barrelLength / 2);
    gunGroup.add(rightBarrel);

    const boreGeom = new THREE.CircleGeometry(barrelRadius * 0.75, 16);
    const leftBore = new THREE.Mesh(boreGeom, mats.boreMat);
    leftBore.position.set(-barrelSpacing / 2, 0.01, -barrelLength - 0.001);
    gunGroup.add(leftBore);

    const rightBore = new THREE.Mesh(boreGeom, mats.boreMat);
    rightBore.position.set(barrelSpacing / 2, 0.01, -barrelLength - 0.001);
    gunGroup.add(rightBore);

    const ribGeom = new THREE.BoxGeometry(0.012, 0.008, barrelLength);
    const rib = new THREE.Mesh(ribGeom, mats.receiverSteelMat);
    rib.position.set(0, 0.024, -barrelLength / 2);
    gunGroup.add(rib);

    const beadGeom = new THREE.SphereGeometry(0.005, 10, 10);
    const bead = new THREE.Mesh(beadGeom, mats.brassMat);
    bead.position.set(0, 0.031, -barrelLength + 0.01);
    gunGroup.add(bead);

    const forendGeom = new THREE.BoxGeometry(0.052, 0.04, 0.32);
    const forend = new THREE.Mesh(forendGeom, mats.walnutWoodMat);
    forend.position.set(0, -0.014, -0.22);
    gunGroup.add(forend);

    const forendCapGeom = new THREE.CylinderGeometry(0.02, 0.025, 0.02, 16);
    forendCapGeom.rotateX(Math.PI / 2);
    const forendCap = new THREE.Mesh(forendCapGeom, mats.receiverSteelMat);
    forendCap.position.set(0, -0.014, -0.38);
    gunGroup.add(forendCap);

    const receiverGeom = new THREE.BoxGeometry(0.056, 0.068, 0.16);
    const receiver = new THREE.Mesh(receiverGeom, mats.receiverSteelMat);
    receiver.position.set(0, -0.004, 0.04);
    gunGroup.add(receiver);

    const leverGeom = new THREE.BoxGeometry(0.01, 0.012, 0.05);
    leverGeom.rotateY(0.2);
    const lever = new THREE.Mesh(leverGeom, mats.bluedSteelMat);
    lever.position.set(0.004, 0.034, 0.03);
    gunGroup.add(lever);

    const gripGeom = new THREE.BoxGeometry(0.046, 0.075, 0.20);
    gripGeom.rotateX(-0.28);
    const grip = new THREE.Mesh(gripGeom, mats.walnutWoodMat);
    grip.position.set(0, -0.058, 0.18);
    gunGroup.add(grip);

    const stockGeom = new THREE.BoxGeometry(0.05, 0.12, 0.32);
    stockGeom.rotateX(-0.16);
    const stock = new THREE.Mesh(stockGeom, mats.walnutWoodMat);
    stock.position.set(0, -0.13, 0.38);
    gunGroup.add(stock);

    const buttGeom = new THREE.BoxGeometry(0.052, 0.125, 0.02);
    buttGeom.rotateX(-0.16);
    const buttplate = new THREE.Mesh(buttGeom, mats.darkWoodMat);
    buttplate.position.set(0, -0.155, 0.54);
    gunGroup.add(buttplate);

    const guardGeom = new THREE.TorusGeometry(0.025, 0.004, 8, 16, Math.PI);
    guardGeom.rotateX(Math.PI);
    const guard = new THREE.Mesh(guardGeom, mats.bluedSteelMat);
    guard.position.set(0, -0.055, 0.08);
    gunGroup.add(guard);

    const trigGeom = new THREE.BoxGeometry(0.003, 0.018, 0.006);
    trigGeom.rotateX(-0.3);
    const trigger1 = new THREE.Mesh(trigGeom, mats.brassMat);
    trigger1.position.set(-0.006, -0.048, 0.075);
    gunGroup.add(trigger1);
    const trigger2 = new THREE.Mesh(trigGeom, mats.brassMat);
    trigger2.position.set(0.006, -0.051, 0.09);
    gunGroup.add(trigger2);

    const flashCanvas = document.createElement('canvas');
    flashCanvas.width = 128;
    flashCanvas.height = 128;
    const fctx = flashCanvas.getContext('2d');
    const fgrad = fctx.createRadialGradient(64, 64, 0, 64, 64, 64);
    fgrad.addColorStop(0, 'rgba(255, 255, 255, 1)');
    fgrad.addColorStop(0.2, 'rgba(255, 220, 90, 0.95)');
    fgrad.addColorStop(0.5, 'rgba(255, 110, 15, 0.7)');
    fgrad.addColorStop(0.8, 'rgba(255, 40, 0, 0.25)');
    fgrad.addColorStop(1, 'rgba(0, 0, 0, 0)');
    fctx.fillStyle = fgrad;
    fctx.fillRect(0, 0, 128, 128);
    const flashTex = new THREE.CanvasTexture(flashCanvas);

    const flashSprite = new THREE.Sprite(new THREE.SpriteMaterial({
      map: flashTex,
      transparent: true,
      blending: THREE.AdditiveBlending,
      depthWrite: false
    }));
    flashSprite.scale.set(0.38, 0.38, 0.38);
    flashSprite.position.set(0, 0.01, -barrelLength - 0.08);
    flashSprite.visible = false;
    gunGroup.add(flashSprite);

    const muzzleLight = new THREE.PointLight(0xFF9922, 0, 6.5, 1.8);
    muzzleLight.position.set(0, 0.015, -barrelLength - 0.06);
    gunGroup.add(muzzleLight);

    const basePos = new THREE.Vector3(0.22, -0.21, -0.52);
    const baseRot = new THREE.Euler(-0.06, -0.14, 0.035, 'YXZ');

    gunGroup.scale.set(1.15, 1.15, 1.15);
    gunGroup.position.copy(basePos);
    gunGroup.rotation.copy(baseRot);

    return {
      gun: gunGroup,
      flashSprite,
      muzzleLight,
      barrelLength,
      basePos,
      baseRot,
      recoilZ: 0,
      recoilRotX: 0,
      swayX: 0,
      swayY: 0
    };
  }

  /**
   * Factory Paperelle Gialle con dotazione tattica
   */
  function createFunnyYellowDuck(THREE, type = 'goofy', weaponType = 'none', customBodyMat = null) {
    const assets = initSharedAssets(THREE);
    const { mats, geoms } = assets;
    const duck = new THREE.Group();

    const isKing = (type === 'king');
    const isCool = (type === 'cool');
    const isDerpy = (type === 'derpy');

    const bodyMat = customBodyMat || (isKing ? mats.duckGoldMat : mats.duckYellowMat);

    const bodyMesh = new THREE.Mesh(geoms.bodyGeom, bodyMat);
    duck.add(bodyMesh);

    const headMesh = new THREE.Mesh(geoms.headGeom, bodyMat);
    headMesh.position.set(0, 0.28, 0.24);
    duck.add(headMesh);

    const tuftGroup = new THREE.Group();
    tuftGroup.position.set(0, 0.52, 0.24);
    tuftGroup.add(new THREE.Mesh(geoms.featherGeom1, bodyMat));
    tuftGroup.add(new THREE.Mesh(geoms.featherGeom2, bodyMat));
    duck.add(tuftGroup);

    const leftCheek = new THREE.Mesh(geoms.cheekGeom, mats.cheekMat);
    leftCheek.position.set(-0.19, 0.23, 0.38);
    duck.add(leftCheek);
    const rightCheek = new THREE.Mesh(geoms.cheekGeom, mats.cheekMat);
    rightCheek.position.set(0.19, 0.23, 0.38);
    duck.add(rightCheek);

    const leftEyeGroup = new THREE.Group();
    leftEyeGroup.position.set(-0.11, 0.34, 0.42);
    leftEyeGroup.add(new THREE.Mesh(geoms.eyeGeom, mats.eyeWhiteMat));
    const pupilL = new THREE.Mesh(geoms.pupilGeom, mats.eyePupilMat);
    pupilL.position.set(isDerpy ? 0.02 : 0, 0, 0.05);
    leftEyeGroup.add(pupilL);
    const glintL = new THREE.Mesh(geoms.glintBigGeom, mats.eyeWhiteMat);
    glintL.position.set(-0.015, 0.02, 0.08);
    leftEyeGroup.add(glintL);
    duck.add(leftEyeGroup);

    const rightEyeGroup = new THREE.Group();
    rightEyeGroup.position.set(0.11, 0.34, 0.42);
    rightEyeGroup.add(new THREE.Mesh(geoms.eyeGeom, mats.eyeWhiteMat));
    const pupilR = new THREE.Mesh(geoms.pupilGeom, mats.eyePupilMat);
    pupilR.position.set(isDerpy ? -0.025 : 0, 0, 0.05);
    rightEyeGroup.add(pupilR);
    const glintR = new THREE.Mesh(geoms.glintBigGeom, mats.eyeWhiteMat);
    glintR.position.set(-0.015, 0.02, 0.08);
    rightEyeGroup.add(glintR);
    duck.add(rightEyeGroup);

    let glassesMesh = null;
    if (isCool) {
      glassesMesh = new THREE.Mesh(geoms.frameGeom, mats.sunglassesMat);
      glassesMesh.position.set(0, 0.34, 0.49);
      duck.add(glassesMesh);
    }

    const upperBill = new THREE.Mesh(geoms.upperBillGeom, mats.beakMat);
    upperBill.position.set(0, 0.22, 0.50);
    duck.add(upperBill);

    const lowerBill = new THREE.Mesh(geoms.lowerBillGeom, mats.beakMat);
    lowerBill.position.set(0, 0.17, 0.48);
    duck.add(lowerBill);

    const tongue = new THREE.Mesh(geoms.tongueGeom, mats.tongueMat);
    tongue.position.set(isDerpy ? 0.03 : 0, 0.18, 0.52);
    if (isDerpy) tongue.rotateZ(0.25);
    duck.add(tongue);

    const tail = new THREE.Mesh(geoms.tailGeom, bodyMat);
    tail.position.set(0, 0.16, -0.42);
    duck.add(tail);

    const leftFootGroup = new THREE.Group();
    leftFootGroup.position.set(-0.14, -0.16, -0.16);
    leftFootGroup.add(new THREE.Mesh(geoms.legGeom, mats.feetMat));
    const lFoot = new THREE.Mesh(geoms.footGeom, mats.feetMat);
    lFoot.position.set(0, -0.07, -0.12);
    leftFootGroup.add(lFoot);
    duck.add(leftFootGroup);

    const rightFootGroup = new THREE.Group();
    rightFootGroup.position.set(0.14, -0.16, -0.16);
    rightFootGroup.add(new THREE.Mesh(geoms.legGeom, mats.feetMat));
    const rFoot = new THREE.Mesh(geoms.footGeom, mats.feetMat);
    rFoot.position.set(0, -0.07, -0.12);
    rightFootGroup.add(rFoot);
    duck.add(rightFootGroup);

    const leftWingPivot = new THREE.Group();
    leftWingPivot.position.set(-0.34, 0.06, 0.04);
    const leftWing = new THREE.Mesh(geoms.wingGeom, bodyMat);
    leftWing.position.set(-0.12, 0, 0);
    leftWingPivot.add(leftWing);
    duck.add(leftWingPivot);

    const rightWingPivot = new THREE.Group();
    rightWingPivot.position.set(0.34, 0.06, 0.04);
    const rightWing = new THREE.Mesh(geoms.wingGeom, bodyMat);
    rightWing.position.set(0.12, 0, 0);
    rightWingPivot.add(rightWing);
    duck.add(rightWingPivot);

    if (isKing) {
      const crownGroup = new THREE.Group();
      crownGroup.position.set(0.06, 0.54, 0.22);
      crownGroup.rotation.z = -0.25;
      const crownMesh = new THREE.Mesh(geoms.crownGeom, mats.crownMat);
      crownGroup.add(crownMesh);
      const gem = new THREE.Mesh(geoms.gemGeom, mats.crownGemMat);
      gem.position.set(0, 0.06, 0.10);
      crownGroup.add(gem);
      duck.add(crownGroup);
    }

    // --- AGGANCIO ARMI TATTICHE NEMICHE ---
    let weaponMesh = null;
    if (weaponType === 'knife') {
      weaponMesh = createKnife3D(THREE);
      weaponMesh.position.set(0.22, 0.04, 0.32);
      weaponMesh.rotation.set(0.1, -0.2, -0.3);
      duck.add(weaponMesh);
    } else if (weaponType === 'pistol') {
      weaponMesh = createPistol3D(THREE);
      weaponMesh.position.set(0.24, 0.05, 0.28);
      duck.add(weaponMesh);
    } else if (weaponType === 'rpg') {
      weaponMesh = createBazooka3D(THREE);
      weaponMesh.position.set(-0.20, 0.32, 0.05);
      duck.add(weaponMesh);

      const helmet = createMilitaryHelmet(THREE);
      helmet.position.set(0, 0.44, 0.24);
      duck.add(helmet);
    }

    const hitCollider = new THREE.Mesh(geoms.colliderGeom, mats.colliderMat);
    hitCollider.name = "hit_collider";
    hitCollider.position.set(0, 0.15, 0.1);
    duck.add(hitCollider);

    duck.userData = {
      type,
      weaponType,
      weaponMesh,
      glassesMesh,
      bodyMesh,
      headMesh,
      points: isKing ? 500 : (isCool ? 250 : (isDerpy ? 150 : 100)),
      name: isKing ? "KING QUACK" : (isCool ? "COOL DUCK" : (isDerpy ? "DERP DUCK" : "GOOFY DUCK")),
      hitCollider,
      tuftGroup,
      leftWing: leftWingPivot,
      rightWing: rightWingPivot,
      leftFoot: leftFootGroup,
      rightFoot: rightFootGroup,
      hit: false,
      wingPhase: Math.random() * Math.PI * 2,
      wobblePhase: Math.random() * Math.PI * 2,
      flapSpeed: 24.0
    };

    return duck;
  }

  /**
   * Costruisce una Paperella Postina 3D con pacco brandizzato (Instagram Magenta o TikTok Nera)
   */
  function createDeliveryDuck3D(THREE, brand = 'instagram') {
    const isInsta = (brand === 'instagram');
    const group = new THREE.Group();

    // 1. Materiale distintivo per il corpo a colore del rispettivo social (IG Magenta vs TikTok Nero)
    const socialDuckMat = isInsta
      ? new THREE.MeshStandardMaterial({
          color: 0xE1306C, // Magenta Instagram vivido
          roughness: 0.32,
          metalness: 0.15,
          emissive: 0x4A0028,
          emissiveIntensity: 0.28
        })
      : new THREE.MeshStandardMaterial({
          color: 0x111218, // Nero stealth profondo ed elegante per TikTok
          roughness: 0.30,
          metalness: 0.30,
          emissive: 0x050812,
          emissiveIntensity: 0.22
        });

    // 2. Paperella base 3D con piumaggio colorato social
    const duckMesh = createFunnyYellowDuck(THREE, 'cool', 'none', socialDuckMat);
    duckMesh.scale.set(1.15, 1.15, 1.15);

    // Occhiali da sole stilizzati abbinati all'estetica del social
    if (duckMesh.userData && duckMesh.userData.glassesMesh) {
      if (isInsta) {
        duckMesh.userData.glassesMesh.material = new THREE.MeshStandardMaterial({
          color: 0xFFD700, // Montatura dorata chic
          roughness: 0.2,
          metalness: 0.85,
          emissive: 0x553800,
          emissiveIntensity: 0.35
        });
      } else {
        duckMesh.userData.glassesMesh.material = new THREE.MeshStandardMaterial({
          color: 0x00F2FE, // Montatura ciano elettrico TikTok (#00F2FE)
          roughness: 0.2,
          metalness: 0.65,
          emissive: 0x004555,
          emissiveIntensity: 0.55
        });
      }
    }

    group.add(duckMesh);

    // 3. Pacco postale brandizzato 3D apribile sotto la paperella
    const pkgGroup = new THREE.Group();
    pkgGroup.position.set(0, -0.42, 0.05);

    // Materiali scatola
    const boxMat = new THREE.MeshStandardMaterial({
      color: isInsta ? 0xE1306C : 0x0A0B10,
      roughness: isInsta ? 0.35 : 0.25,
      metalness: isInsta ? 0.25 : 0.45,
      emissive: isInsta ? 0x4D0B24 : 0x011520,
      emissiveIntensity: 0.4
    });

    const ribbonMat = new THREE.MeshStandardMaterial({
      color: isInsta ? 0xFFDC80 : 0x00F2FE,
      roughness: 0.2,
      metalness: 0.4,
      emissive: isInsta ? 0x553800 : 0x005566,
      emissiveIntensity: 0.6
    });

    // Corpo scatola (base aperta superiormente)
    const boxBaseGeom = new THREE.BoxGeometry(0.42, 0.28, 0.42);
    const boxBaseMesh = new THREE.Mesh(boxBaseGeom, boxMat);
    boxBaseMesh.position.set(0, -0.06, 0);
    pkgGroup.add(boxBaseMesh);

    // Nastri decorativi sul corpo scatola
    const ribbonGeomX = new THREE.BoxGeometry(0.43, 0.29, 0.08);
    const ribbonGeomZ = new THREE.BoxGeometry(0.08, 0.29, 0.43);
    const ribBaseX = new THREE.Mesh(ribbonGeomX, ribbonMat);
    ribBaseX.position.set(0, -0.06, 0);
    pkgGroup.add(ribBaseX);
    const ribBaseZ = new THREE.Mesh(ribbonGeomZ, ribbonMat);
    ribBaseZ.position.set(0, -0.06, 0);
    pkgGroup.add(ribBaseZ);

    // Coperchio apribile su perno posteriore
    const lidPivot = new THREE.Group();
    lidPivot.position.set(0, 0.08, -0.21); // perno cerniera posteriore

    const lidMesh = new THREE.Mesh(new THREE.BoxGeometry(0.44, 0.05, 0.44), boxMat);
    lidMesh.position.set(0, 0.025, 0.21); // centrato rispetto al perno
    lidPivot.add(lidMesh);

    // Fiocco e nastri sul coperchio
    const lidRibbonX = new THREE.Mesh(new THREE.BoxGeometry(0.45, 0.06, 0.08), ribbonMat);
    lidRibbonX.position.set(0, 0.025, 0.21);
    lidPivot.add(lidRibbonX);
    const lidRibbonZ = new THREE.Mesh(new THREE.BoxGeometry(0.08, 0.06, 0.45), ribbonMat);
    lidRibbonZ.position.set(0, 0.025, 0.21);
    lidPivot.add(lidRibbonZ);

    const bowGeom = new THREE.TorusGeometry(0.065, 0.022, 8, 16);
    const bowMesh1 = new THREE.Mesh(bowGeom, ribbonMat);
    bowMesh1.position.set(-0.04, 0.07, 0.21);
    bowMesh1.rotation.y = Math.PI / 4;
    lidPivot.add(bowMesh1);
    const bowMesh2 = new THREE.Mesh(bowGeom, ribbonMat);
    bowMesh2.position.set(0.04, 0.07, 0.21);
    bowMesh2.rotation.y = -Math.PI / 4;
    lidPivot.add(bowMesh2);

    pkgGroup.add(lidPivot);

    // 3. Scheda/Pulsante 3D che spunta fuori dall'interno della scatola!
    const popCardGroup = new THREE.Group();
    popCardGroup.position.set(0, -0.06, 0); // inizialmente dentro la scatola
    popCardGroup.scale.set(0.001, 0.001, 0.001);

    // Mesh cartello/pulsante 3D
    const cardGeom = new THREE.BoxGeometry(0.36, 0.26, 0.03);
    const cardMat = new THREE.MeshStandardMaterial({
      color: isInsta ? 0xFF007F : 0x00F0FF,
      roughness: 0.2,
      metalness: 0.3,
      emissive: isInsta ? 0x550022 : 0x003344,
      emissiveIntensity: 0.5
    });
    const cardMesh = new THREE.Mesh(cardGeom, cardMat);
    popCardGroup.add(cardMesh);

    // Texture grafica frontale del pulsante 3D
    const pCanvas = document.createElement('canvas');
    pCanvas.width = 256;
    pCanvas.height = 192;
    const pCtx = pCanvas.getContext('2d');
    pCtx.fillStyle = isInsta ? '#E1306C' : '#0F121C';
    pCtx.fillRect(0, 0, 256, 192);
    pCtx.strokeStyle = isInsta ? '#FFE500' : '#00F2FE';
    pCtx.lineWidth = 6;
    pCtx.strokeRect(4, 4, 248, 184);

    pCtx.font = 'bold 52px sans-serif';
    pCtx.textAlign = 'center';
    pCtx.fillStyle = '#FFFFFF';
    pCtx.fillText(isInsta ? '📸' : '🎵', 128, 64);

    pCtx.font = 'bold 22px monospace';
    pCtx.fillStyle = '#FFFFFF';
    pCtx.fillText(isInsta ? 'INSTAGRAM' : 'TIKTOK', 128, 110);

    pCtx.fillStyle = isInsta ? '#FFE500' : '#00F0FF';
    pCtx.font = 'bold 18px monospace';
    pCtx.fillText(isInsta ? 'TOCCA QUI!' : 'TOCCA QUI!', 128, 150);

    const cardTex = new THREE.CanvasTexture(pCanvas);
    const cardFrontMat = new THREE.MeshBasicMaterial({ map: cardTex });
    const cardFrontMesh = new THREE.Mesh(new THREE.PlaneGeometry(0.34, 0.24), cardFrontMat);
    cardFrontMesh.position.set(0, 0, 0.017);
    popCardGroup.add(cardFrontMesh);

    // Punto di ancoraggio per posizionare il pulsante HTML a schermo
    const anchorPoint = new THREE.Object3D();
    anchorPoint.position.set(0, 0.22, 0);
    popCardGroup.add(anchorPoint);

    pkgGroup.add(popCardGroup);

    // Corde di sospensione alle zampette della paperella
    const ropeMat = new THREE.MeshBasicMaterial({ color: 0xD4AF37 });
    const ropeGeom = new THREE.CylinderGeometry(0.008, 0.008, 0.28, 6);
    const ropeL = new THREE.Mesh(ropeGeom, ropeMat);
    ropeL.position.set(-0.14, 0.15, 0);
    pkgGroup.add(ropeL);
    const ropeR = new THREE.Mesh(ropeGeom, ropeMat);
    ropeR.position.set(0.14, 0.15, 0);
    pkgGroup.add(ropeR);

    // Logo frontale sulla base della scatola
    const badgeGeom = new THREE.PlaneGeometry(0.20, 0.20);
    const canvas = document.createElement('canvas');
    canvas.width = 128;
    canvas.height = 128;
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = isInsta ? '#E1306C' : '#000000';
    ctx.fillRect(0, 0, 128, 128);
    ctx.font = 'bold 50px sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillStyle = '#FFFFFF';
    ctx.fillText(isInsta ? '📸' : '🎵', 64, 64);

    const badgeTex = new THREE.CanvasTexture(canvas);
    const badgeMat = new THREE.MeshBasicMaterial({ map: badgeTex });
    const badgeMesh = new THREE.Mesh(badgeGeom, badgeMat);
    badgeMesh.position.set(0, -0.06, 0.212);
    pkgGroup.add(badgeMesh);

    group.add(pkgGroup);

    // 4. Collider generoso per tocco su mobile a distanza
    const colliderGeom = new THREE.SphereGeometry(0.85, 8, 8);
    const colliderMat = new THREE.MeshBasicMaterial({ visible: false });
    const colliderMesh = new THREE.Mesh(colliderGeom, colliderMat);
    colliderMesh.position.set(0, -0.05, 0);
    group.add(colliderMesh);

    return {
      group,
      duckMesh,
      pkgGroup,
      lidPivot,
      popCardGroup,
      anchorPoint,
      colliderMesh,
      brand,
      side: isInsta ? -1 : 1,
      url: isInsta ? CONFIG.instagramUrl : CONFIG.tiktokUrl,
      progress: 0,
      boxOpenProgress: 0,
      phase: isInsta ? 0 : Math.PI,
      isHappy: false,
      happyTimer: 0
    };
  }

  // =========================================================================
  // 6. GESTORE PROIETTILI NEMICI & INTERCETTAZIONE (BULLETS & RPG ROCKETS)
  // =========================================================================
  class ProjectilesManager {
    constructor(THREE, scene) {
      this.THREE = THREE;
      this.scene = scene;
      this.projectiles = [];
      this.hittableColliders = [];

      this.bulletGeom = new THREE.SphereGeometry(0.09, 10, 10);
      this.bulletMat = new THREE.MeshStandardMaterial({
        color: 0xFFAA00,
        emissive: 0xFF5500,
        emissiveIntensity: 1.6,
        roughness: 0.2
      });

      this.rocketBodyGeom = new THREE.CylinderGeometry(0.045, 0.045, 0.34, 10);
      this.rocketBodyGeom.rotateX(Math.PI / 2);
      this.rocketNoseGeom = new THREE.ConeGeometry(0.045, 0.13, 10);
      this.rocketNoseGeom.rotateX(Math.PI / 2);
      this.rocketFinGeom = new THREE.BoxGeometry(0.18, 0.18, 0.015);

      this.rocketMat = new THREE.MeshStandardMaterial({
        color: 0x384B2F,
        metalness: 0.4,
        roughness: 0.4
      });
      this.rocketNoseMat = new THREE.MeshStandardMaterial({
        color: 0xD62200,
        emissive: 0x990000,
        emissiveIntensity: 0.7
      });

      this.bulletColliderGeom = new THREE.SphereGeometry(0.35, 8, 8);
      this.rocketColliderGeom = new THREE.SphereGeometry(0.50, 8, 8);
      this.colliderMat = new THREE.MeshBasicMaterial({ visible: false });
    }

    spawnBullet(origin, targetPos) {
      const THREE = this.THREE;
      const mesh = new THREE.Mesh(this.bulletGeom, this.bulletMat);
      mesh.position.copy(origin);

      const collider = new THREE.Mesh(this.bulletColliderGeom, this.colliderMat);
      mesh.add(collider);

      const dir = new THREE.Vector3().subVectors(targetPos, origin).normalize();
      const speed = 4.2;
      const vel = dir.clone().multiplyScalar(speed);

      const proj = {
        type: 'bullet',
        mesh,
        collider,
        vel,
        damage: 15,
        life: 4.5,
        alive: true
      };
      collider.userData.projectileData = proj;

      this.scene.add(mesh);
      this.projectiles.push(proj);
      this.hittableColliders.push(collider);
    }

    spawnRocket(origin, targetPos) {
      const THREE = this.THREE;
      const group = new THREE.Group();
      group.position.copy(origin);

      const body = new THREE.Mesh(this.rocketBodyGeom, this.rocketMat);
      group.add(body);

      const nose = new THREE.Mesh(this.rocketNoseGeom, this.rocketNoseMat);
      nose.position.set(0, 0, -0.23);
      group.add(nose);

      const fins = new THREE.Mesh(this.rocketFinGeom, this.rocketMat);
      fins.position.set(0, 0, 0.14);
      group.add(fins);

      const collider = new THREE.Mesh(this.rocketColliderGeom, this.colliderMat);
      group.add(collider);

      const dir = new THREE.Vector3().subVectors(targetPos, origin).normalize();
      group.lookAt(group.position.x + dir.x, group.position.y + dir.y, group.position.z + dir.z);

      const speed = 2.3;
      const vel = dir.clone().multiplyScalar(speed);

      const proj = {
        type: 'rocket',
        mesh: group,
        collider,
        vel,
        damage: 45,
        life: 6.5,
        alive: true,
        smokeTimer: 0
      };
      collider.userData.projectileData = proj;

      this.scene.add(group);
      this.projectiles.push(proj);
      this.hittableColliders.push(collider);
    }

    update(dt, cameraPos, onHitPlayer, smokeSystem) {
      for (let i = this.projectiles.length - 1; i >= 0; i--) {
        const p = this.projectiles[i];
        if (!p.alive) {
          this.removeProjectile(i);
          continue;
        }

        p.life -= dt;
        if (p.life <= 0) {
          this.removeProjectile(i);
          continue;
        }

        p.mesh.position.addScaledVector(p.vel, dt);

        if (p.type === 'rocket' && smokeSystem) {
          p.smokeTimer += dt;
          if (p.smokeTimer >= 0.065) {
            p.smokeTimer = 0;
            smokeSystem.emit(p.mesh.position, 1);
          }
        }

        const dist = p.mesh.position.distanceTo(cameraPos);
        const threshold = (p.type === 'rocket') ? 0.65 : 0.45;
        if (dist < threshold) {
          onHitPlayer(p.damage, p.type);
          this.removeProjectile(i);
        }
      }
    }

    removeProjectile(index) {
      const p = this.projectiles[index];
      if (p) {
        p.alive = false;
        const colIdx = this.hittableColliders.indexOf(p.collider);
        if (colIdx !== -1) this.hittableColliders.splice(colIdx, 1);
        if (p.mesh.parent) p.mesh.parent.remove(p.mesh);
        this.projectiles.splice(index, 1);
      }
    }

    clear() {
      for (let i = this.projectiles.length - 1; i >= 0; i--) {
        this.removeProjectile(i);
      }
      this.projectiles = [];
      this.hittableColliders = [];
    }
  }

  // =========================================================================
  // 7. SISTEMA FUMO DALLA CANNA
  // =========================================================================
  class BarrelSmokeSystem {
    constructor(THREE, maxPuffs = 20) {
      this.THREE = THREE;
      this.group = new THREE.Group();
      this.puffs = [];

      const canvas = document.createElement('canvas');
      canvas.width = 64;
      canvas.height = 64;
      const ctx = canvas.getContext('2d');
      const grad = ctx.createRadialGradient(32, 32, 0, 32, 32, 32);
      grad.addColorStop(0, 'rgba(235, 235, 245, 0.7)');
      grad.addColorStop(0.35, 'rgba(200, 205, 220, 0.45)');
      grad.addColorStop(0.7, 'rgba(160, 165, 180, 0.15)');
      grad.addColorStop(1, 'rgba(0, 0, 0, 0)');
      ctx.fillStyle = grad;
      ctx.fillRect(0, 0, 64, 64);
      const smokeTex = new THREE.CanvasTexture(canvas);

      for (let i = 0; i < maxPuffs; i++) {
        const mat = new THREE.SpriteMaterial({
          map: smokeTex,
          transparent: true,
          opacity: 0,
          depthWrite: false,
          blending: THREE.NormalBlending
        });
        const sprite = new THREE.Sprite(mat);
        sprite.visible = false;
        this.group.add(sprite);

        this.puffs.push({
          sprite,
          mat,
          active: false,
          pos: new THREE.Vector3(),
          vel: new THREE.Vector3(),
          rotSpeed: 0,
          scale: 0.08,
          growthRate: 0.22,
          life: 0,
          maxLife: 0.8
        });
      }
    }

    emit(worldOrigin, count = 4) {
      let spawned = 0;
      for (let i = 0; i < this.puffs.length && spawned < count; i++) {
        const p = this.puffs[i];
        if (!p.active) {
          p.active = true;
          p.life = 0.6 + Math.random() * 0.35;
          p.maxLife = p.life;
          p.scale = 0.06 + Math.random() * 0.04;
          p.growthRate = 0.2 + Math.random() * 0.15;
          p.rotSpeed = (Math.random() - 0.5) * 2.5;

          p.pos.copy(worldOrigin);
          p.pos.x += (Math.random() - 0.5) * 0.04;
          p.pos.y += (Math.random() - 0.5) * 0.03;
          p.pos.z += (Math.random() - 0.5) * 0.04;

          p.vel.set(
            (Math.random() - 0.5) * 0.08,
            0.22 + Math.random() * 0.18,
            (Math.random() - 0.5) * 0.08
          );

          p.sprite.position.copy(p.pos);
          p.sprite.scale.set(p.scale, p.scale, p.scale);
          p.mat.opacity = 0.6;
          p.mat.rotation = Math.random() * Math.PI * 2;
          p.sprite.visible = true;
          spawned++;
        }
      }
    }

    update(dt) {
      for (let i = 0; i < this.puffs.length; i++) {
        const p = this.puffs[i];
        if (p.active) {
          p.life -= dt;
          if (p.life <= 0) {
            p.active = false;
            p.sprite.visible = false;
            p.mat.opacity = 0;
          } else {
            p.pos.x += p.vel.x * dt;
            p.pos.y += p.vel.y * dt;
            p.pos.z += p.vel.z * dt;
            p.vel.y += dt * 0.12;

            p.scale += p.growthRate * dt;
            p.mat.rotation += p.rotSpeed * dt;

            const ratio = p.life / p.maxLife;
            p.mat.opacity = ratio * 0.55;

            p.sprite.position.copy(p.pos);
            p.sprite.scale.set(p.scale, p.scale, p.scale);
          }
        }
      }
    }
  }

  // =========================================================================
  // 8. SISTEMA 3D BILLBOARD SCORE POPUPS
  // =========================================================================
  class ScorePopups3DSystem {
    constructor(THREE, maxPopups = 8) {
      this.THREE = THREE;
      this.group = new THREE.Group();
      this.pool = [];

      for (let i = 0; i < maxPopups; i++) {
        const canvas = document.createElement('canvas');
        canvas.width = 256;
        canvas.height = 128;
        const ctx = canvas.getContext('2d');
        const texture = new THREE.CanvasTexture(canvas);

        const mat = new THREE.SpriteMaterial({
          map: texture,
          transparent: true,
          opacity: 0,
          depthWrite: false
        });
        const sprite = new THREE.Sprite(mat);
        sprite.visible = false;
        this.group.add(sprite);

        this.pool.push({
          sprite,
          mat,
          canvas,
          ctx,
          texture,
          active: false,
          pos: new THREE.Vector3(),
          life: 0,
          maxLife: 0.85,
          baseScale: 0.95
        });
      }
    }

    spawn(text, worldPos, isBonus = false) {
      for (let i = 0; i < this.pool.length; i++) {
        const p = this.pool[i];
        if (!p.active) {
          p.active = true;
          p.life = 0.85;
          p.maxLife = 0.85;
          p.pos.copy(worldPos);
          p.pos.y += 0.25;

          const ctx = p.ctx;
          ctx.clearRect(0, 0, 256, 128);

          ctx.font = '900 32px "Outfit", sans-serif';
          ctx.textAlign = 'center';
          ctx.textBaseline = 'middle';

          ctx.shadowColor = isBonus ? '#00F0FF' : '#FFE600';
          ctx.shadowBlur = 14;

          ctx.strokeStyle = '#08080C';
          ctx.lineWidth = 6;
          ctx.strokeText(text, 128, 64);

          ctx.fillStyle = isBonus ? '#00F0FF' : '#FFFFFF';
          ctx.fillText(text, 128, 64);

          p.texture.needsUpdate = true;
          p.sprite.position.copy(p.pos);
          p.sprite.scale.set(p.baseScale, p.baseScale * 0.5, 1);
          p.mat.opacity = 1.0;
          p.sprite.visible = true;
          break;
        }
      }
    }

    update(dt) {
      for (let i = 0; i < this.pool.length; i++) {
        const p = this.pool[i];
        if (p.active) {
          p.life -= dt;
          if (p.life <= 0) {
            p.active = false;
            p.sprite.visible = false;
            p.mat.opacity = 0;
          } else {
            p.pos.y += 0.85 * dt;
            p.sprite.position.copy(p.pos);

            const ratio = p.life / p.maxLife;
            p.mat.opacity = Math.min(1.0, ratio * 1.5);
            const scale = p.baseScale * (0.8 + ratio * 0.35);
            p.sprite.scale.set(scale, scale * 0.5, 1);
          }
        }
      }
    }
  }

  // =========================================================================
  // 9. MOTORE PARTICELLARE PIUME CARTOON
  // =========================================================================
  function createParticleEngine(THREE, maxParticles = 240) {
    const group = new THREE.Group();
    const positions = new Float32Array(maxParticles * 3);
    const colors = new Float32Array(maxParticles * 3);
    const sizes = new Float32Array(maxParticles);

    const geom = new THREE.BufferGeometry();
    geom.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    geom.setAttribute('color', new THREE.BufferAttribute(colors, 3));
    geom.setAttribute('size', new THREE.BufferAttribute(sizes, 1));

    const particles = [];
    for (let i = 0; i < maxParticles; i++) {
      particles.push({
        active: false,
        pos: new THREE.Vector3(),
        vel: new THREE.Vector3(),
        life: 0,
        maxLife: 1.0,
        color: new THREE.Color(),
        size: 0.05
      });
      sizes[i] = 0;
    }

    const canvas = document.createElement('canvas');
    canvas.width = 64;
    canvas.height = 64;
    const ctx = canvas.getContext('2d');
    const grad = ctx.createRadialGradient(32, 32, 0, 32, 32, 32);
    grad.addColorStop(0, 'rgba(255, 255, 255, 1)');
    grad.addColorStop(0.35, 'rgba(255, 230, 0, 0.95)');
    grad.addColorStop(0.75, 'rgba(255, 107, 0, 0.45)');
    grad.addColorStop(1, 'rgba(0, 0, 0, 0)');
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, 64, 64);
    const texture = new THREE.CanvasTexture(canvas);

    const mat = new THREE.PointsMaterial({
      size: 0.08,
      map: texture,
      vertexColors: true,
      transparent: true,
      blending: THREE.AdditiveBlending,
      depthWrite: false
    });

    const points = new THREE.Points(geom, mat);
    group.add(points);

    function burst(origin, count = 36, primaryHex = CONFIG.colors.duckYellow) {
      let emitted = 0;
      const palette = [
        primaryHex,
        CONFIG.colors.pureWhite,
        CONFIG.colors.duckGold,
        CONFIG.colors.duckBeak,
        CONFIG.colors.duckCheek
      ];

      for (let i = 0; i < maxParticles && emitted < count; i++) {
        const p = particles[i];
        if (!p.active) {
          p.active = true;
          p.pos.copy(origin);
          const speed = 1.2 + Math.random() * 2.4;
          const theta = Math.random() * Math.PI * 2;
          const phi = Math.acos((Math.random() * 2) - 1);

          p.vel.set(
            Math.sin(phi) * Math.cos(theta) * speed,
            Math.sin(phi) * Math.sin(theta) * speed + 0.6,
            Math.cos(phi) * speed
          );

          p.life = 0.65 + Math.random() * 0.45;
          p.maxLife = p.life;
          p.size = 0.07 + Math.random() * 0.07;
          p.color.setHex(palette[Math.floor(Math.random() * palette.length)]);
          emitted++;
        }
      }
    }

    function update(dt) {
      const posAttr = geom.attributes.position;
      const colAttr = geom.attributes.color;

      for (let i = 0; i < maxParticles; i++) {
        const p = particles[i];
        if (p.active) {
          p.life -= dt;
          if (p.life <= 0) {
            p.active = false;
            sizes[i] = 0;
          } else {
            p.vel.y -= 3.5 * dt;
            p.pos.x += p.vel.x * dt;
            p.pos.y += p.vel.y * dt;
            p.pos.z += p.vel.z * dt;

            const ratio = p.life / p.maxLife;
            sizes[i] = p.size * ratio;

            positions[i * 3] = p.pos.x;
            positions[i * 3 + 1] = p.pos.y;
            positions[i * 3 + 2] = p.pos.z;

            colors[i * 3] = p.color.r * ratio;
            colors[i * 3 + 1] = p.color.g * ratio;
            colors[i * 3 + 2] = p.color.b * ratio;
          }
        }
      }

      posAttr.needsUpdate = true;
      colAttr.needsUpdate = true;
      geom.attributes.size.needsUpdate = true;
    }

    function burstFeathers(origin, count = 26, primaryHex = CONFIG.colors.duckYellow) {
      let emitted = 0;
      const featherPalette = [
        primaryHex,
        CONFIG.colors.pureWhite,
        CONFIG.colors.duckGold,
        0xFFEE55,
        0xFFAA00
      ];

      for (let i = 0; i < maxParticles && emitted < count; i++) {
        const p = particles[i];
        if (!p.active) {
          p.active = true;
          p.pos.copy(origin);
          const speed = 0.6 + Math.random() * 1.6;
          const theta = Math.random() * Math.PI * 2;
          const phi = Math.acos((Math.random() * 2) - 1);

          p.vel.set(
            Math.sin(phi) * Math.cos(theta) * speed,
            Math.sin(phi) * Math.sin(theta) * speed + 0.8,
            Math.cos(phi) * speed
          );

          p.life = 0.8 + Math.random() * 0.5;
          p.maxLife = p.life;
          p.size = 0.10 + Math.random() * 0.08;
          p.color.setHex(featherPalette[Math.floor(Math.random() * featherPalette.length)]);
          emitted++;
        }
      }
    }

    return { group, burst, burstFeathers, update };
  }

  // =========================================================================
  // 9B. MR.DUCK VOICE ASSISTANT (WEB SPEECH RECOGNITION it-IT)
  // =========================================================================
  class MrDuckVoiceAssistant {
    constructor() {
      this.SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition || null;
      this.recognition = null;
      this.isListening = false;
      this.active = false;
      this.manualStop = false;
      this.isSending = false;

      // Gestione stato trascrizione continua
      this.accumulatedText = '';
      this.currentInterim = '';
      this.currentSessionFinal = '';
      this.silenceTimer = null;
    }

    /**
     * Richiede esplicitamente i permessi audio via getUserMedia per compatibilità iOS/Android
     */
    async ensureMicrophonePermission() {
      if (navigator.mediaDevices && navigator.mediaDevices.getUserMedia) {
        try {
          const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
          stream.getTracks().forEach(track => track.stop());
          return true;
        } catch (err) {
          console.warn('Verifica permessi microfono:', err.name);
          if (err.name === 'NotAllowedError' || err.name === 'PermissionDeniedError') {
            this.updateStatus('⚠️ Permesso microfono negato');
            this.renderTranscript('', '', '⚠️ Permesso microfono negato. Consenti l\'accesso al microfono nel browser.');
            return false;
          }
        }
      }
      return true;
    }

    /**
     * Crea un'istanza pulita di SpeechRecognition (necessario su mobile per evitare InvalidStateError)
     */
    createRecognitionInstance() {
      if (!this.SpeechRecognition) return null;

      if (this.recognition) {
        try {
          this.recognition.onstart = null;
          this.recognition.onresult = null;
          this.recognition.onerror = null;
          this.recognition.onend = null;
          this.recognition.abort();
        } catch (e) {}
        this.recognition = null;
      }

      const rec = new this.SpeechRecognition();
      rec.lang = 'it-IT';
      rec.continuous = true;
      rec.interimResults = true;
      rec.maxAlternatives = 1;

      rec.onstart = () => {
        this.isListening = true;
        this.updateStatus('In ascolto... Parla pure, quack! 🎙️');
        if (DOM.mrduckMicBtn) DOM.mrduckMicBtn.classList.add('mic-listening');
      };

      rec.onaudiostart = () => {
        this.updateStatus('Microfono attivo... ascolto la tua voce!');
      };

      rec.onspeechstart = () => {
        this.updateStatus('Rilevata voce in corso... 🦆✨');
      };

      rec.onresult = (event) => {
        let interim = '';
        let sessionFinal = '';

        for (let i = 0; i < event.results.length; i++) {
          const res = event.results[i];
          if (res.isFinal) {
            sessionFinal += res[0].transcript + ' ';
          } else {
            interim += res[0].transcript;
          }
        }

        this.currentSessionFinal = deduplicateTranscript(sessionFinal);
        this.currentInterim = deduplicateTranscript(interim);

        const fullDisplay = deduplicateTranscript(
          [this.accumulatedText, this.currentSessionFinal].filter(Boolean).join(' ')
        );
        this.renderTranscript(fullDisplay, this.currentInterim);

        // Resetta il timer di silenzio
        clearTimeout(this.silenceTimer);

        // Se l'utente ha formulato del testo, dopo 1.5 secondi di pausa avvia l'elaborazione promemoria
        if (fullDisplay && !this.isSending) {
          this.silenceTimer = setTimeout(() => {
            if (this.active && !this.isSending) {
              const textToSend = deduplicateTranscript(
                [this.accumulatedText, this.currentSessionFinal, this.currentInterim].filter(Boolean).join(' ')
              ).trim();
              if (textToSend) {
                this.finalizeAndSend(textToSend);
              }
            }
          }, 1500);
        }
      };

      rec.onerror = (event) => {
        console.warn('MrDuck Speech Recognition Error:', event.error);

        if (event.error === 'no-speech') {
          // No-speech su mobile è solo un timeout di silenzio temporaneo, non un errore fatale
          return;
        }

        this.isListening = false;
        if (DOM.mrduckMicBtn) DOM.mrduckMicBtn.classList.remove('mic-listening');

        if (event.error === 'not-allowed' || event.error === 'service-not-allowed') {
          this.manualStop = true;
          this.updateStatus('⚠️ Permesso microfono negato');
          this.renderTranscript('', '', '⚠️ Permesso microfono negato. Tocca l\'icona del lucchetto nel browser e concedi l\'accesso al microfono per parlare con Mr.Duck!');
        } else if (event.error === 'network') {
          this.manualStop = true;
          this.updateStatus('⚠️ Connessione di rete assente');
          this.renderTranscript('', '', 'Impossibile contattare il server vocale. Verifica la connessione internet.');
        } else if (event.error === 'audio-capture') {
          this.manualStop = true;
          this.updateStatus('⚠️ Microfono occupato o non trovato');
        } else if (event.error !== 'aborted') {
          this.updateStatus(`Stato: ${event.error}`);
        }
      };

      rec.onend = () => {
        this.isListening = false;
        if (DOM.mrduckMicBtn) DOM.mrduckMicBtn.classList.remove('mic-listening');
        clearTimeout(this.silenceTimer);

        // Se stop manuale o se stiamo già elaborando, non procedere oltre
        if (this.manualStop || this.isSending) return;

        // Se abbiamo catturato testo durante il parlato, finalizziamo subito senza loop continui!
        const candidateText = deduplicateTranscript(
          [this.accumulatedText, this.currentSessionFinal, this.currentInterim].filter(Boolean).join(' ')
        ).trim();

        if (candidateText && candidateText.length >= 2) {
          // L'utente ha completato la frase (silenzio naturale rilevato dal browser)
          this.finalizeAndSend(candidateText);
        } else {
          // Nessuna voce rilevata: stato pulito in attesa di interazione
          this.updateStatus('Ascolto in pausa. Tocca il microfono per parlare 🎙️');
        }
      };

      return rec;
    }

    async open() {
      this.active = true;
      this.manualStop = false;
      this.isSending = false;
      this.accumulatedText = '';
      this.currentInterim = '';
      this.currentSessionFinal = '';
      this.currentReminder = null;
      clearTimeout(this.silenceTimer);

      if (DOM.mrduckModal) {
        DOM.mrduckModal.classList.remove('hidden');
      }
      if (DOM.bottomDock) {
        DOM.bottomDock.classList.add('hidden');
      }
      if (DOM.mrduckReplyBox) {
        DOM.mrduckReplyBox.classList.add('hidden');
      }
      if (DOM.mrduckReminderCard) {
        DOM.mrduckReminderCard.classList.add('hidden');
      }
      if (DOM.btnMrduckCalendar) {
        DOM.btnMrduckCalendar.classList.add('hidden');
      }
      if (DOM.mrduckCalChoices) {
        DOM.mrduckCalChoices.classList.add('hidden');
      }

      this.renderTranscript('', '', 'In attesa della tua voce... parla pure al microfono!');

      if (!this.SpeechRecognition) {
        this.updateStatus('⚠️ Browser non supportato');
        this.renderTranscript('', '', '⚠️ Questo browser non supporta la Web Speech API. Usa Google Chrome su Android o Safari su iOS 14.5+ per parlare con Mr.Duck.');
        return;
      }

      const permOk = await this.ensureMicrophonePermission();
      if (!permOk) return;

      this.startListening();
    }

    close() {
      this.active = false;
      this.manualStop = true;
      clearTimeout(this.silenceTimer);
      this.stopListening();

      if (DOM.mrduckModal) {
        DOM.mrduckModal.classList.add('hidden');
      }
      if (DOM.mrduckMicBtn) {
        DOM.mrduckMicBtn.classList.remove('mic-listening');
      }
      if (DOM.bottomDock && !GAME_STATE.isPlaying && !GAME_STATE.isContactsMode) {
        DOM.bottomDock.classList.remove('hidden');
      }
    }

    startListening() {
      if (!this.SpeechRecognition) return;
      if (this.isListening) return;

      try {
        this.manualStop = false;
        this.recognition = this.createRecognitionInstance();
        if (this.recognition) {
          this.updateStatus('Connessione al microfono...');
          this.recognition.start();
        }
      } catch (err) {
        console.warn('Avvio riconoscimento vocale:', err.message);
      }
    }

    stopListening() {
      clearTimeout(this.silenceTimer);
      if (this.recognition) {
        try {
          this.recognition.onstart = null;
          this.recognition.onaudiostart = null;
          this.recognition.onspeechstart = null;
          this.recognition.onresult = null;
          this.recognition.onerror = null;
          this.recognition.onend = null;
          this.recognition.abort();
        } catch (e) {}
        this.recognition = null;
      }
      this.isListening = false;
      if (DOM.mrduckMicBtn) DOM.mrduckMicBtn.classList.remove('mic-listening');
    }

    toggleListening() {
      if (!this.SpeechRecognition) {
        this.updateStatus('⚠️ Browser non supportato');
        return;
      }

      if (this.isListening) {
        this.manualStop = true;
        this.stopListening();
        this.updateStatus('Ascolto in pausa. Tocca il microfono per parlare 🎙️');
      } else {
        this.manualStop = false;
        this.isSending = false;
        this.startListening();
      }
    }

    retryListening() {
      clearTimeout(this.silenceTimer);
      this.accumulatedText = '';
      this.currentInterim = '';
      this.currentSessionFinal = '';
      this.isSending = false;
      this.manualStop = false;
      this.currentReminder = null;

      if (DOM.mrduckReminderCard) {
        DOM.mrduckReminderCard.classList.add('hidden');
      }
      if (DOM.btnMrduckCalendar) {
        DOM.btnMrduckCalendar.classList.add('hidden');
      }
      if (DOM.mrduckCalChoices) {
        DOM.mrduckCalChoices.classList.add('hidden');
      }
      if (DOM.mrduckReplyBox) {
        DOM.mrduckReplyBox.classList.add('hidden');
      }

      this.renderTranscript('', '', 'In attesa della tua voce... parla pure al microfono!');
      this.stopListening();
      setTimeout(() => this.startListening(), 100);
    }

    async finalizeAndSend(forcedText = null, shouldOpenCalendar = false) {
      if (this.isSending) return;
      this.isSending = true;
      clearTimeout(this.silenceTimer);

      let textToSend = (forcedText || [this.accumulatedText, this.currentSessionFinal, this.currentInterim].filter(Boolean).join(' ')).trim();
      textToSend = deduplicateTranscript(textToSend);

      if (!textToSend) {
        this.isSending = false;
        this.updateStatus('Nessun testo rilevato. Tocca il microfono e parla! 🎙️');
        return;
      }

      this.manualStop = true;
      this.stopListening();

      // Salva stato pulito e sincronizza transcript a video
      this.accumulatedText = textToSend;
      this.currentSessionFinal = '';
      this.currentInterim = '';
      this.renderTranscript(textToSend, '');

      // 1. Analisi frase ed estrazione promemoria per il Calendario
      const reminder = parseReminderText(textToSend);
      this.currentReminder = reminder;

      // 2. Prepara collegamenti diretti Google Calendar e Apple Calendar (.ics)
      const calData = openCalendarEvent(reminder.title, reminder.startDate, reminder.endDate, 'none');

      const ua = navigator.userAgent || '';
      const isIOS = /iPad|iPhone|iPod/.test(ua) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);

      if (DOM.btnMrduckGcal) {
        DOM.btnMrduckGcal.href = calData.gcalUrl;
      }
      if (DOM.btnMrduckApple) {
        if (isIOS) {
          DOM.btnMrduckApple.href = calData.icsDataUri;
        } else {
          try {
            const blob = new Blob([calData.icsContent], { type: 'text/calendar;charset=utf-8' });
            DOM.btnMrduckApple.href = URL.createObjectURL(blob);
          } catch (e) {
            DOM.btnMrduckApple.href = calData.icsDataUri;
          }
        }
      }

      // 3. Mostra a schermo in modo chiaro l'attività e la data/orario calcolati
      if (DOM.mrduckReminderCard && DOM.mrduckParsedDate && DOM.mrduckParsedTitle) {
        DOM.mrduckParsedDate.textContent = '⏰ ' + reminder.humanDate;
        DOM.mrduckParsedTitle.textContent = '📌 ' + reminder.title;
        DOM.mrduckReminderCard.classList.remove('hidden');
      }

      if (DOM.btnMrduckCalendar) {
        DOM.btnMrduckCalendar.classList.remove('hidden');
        if (DOM.mrduckCalBtnText) {
          DOM.mrduckCalBtnText.textContent = '📅 Aggiungi al Calendario';
        }
      }

      if (DOM.mrduckCalChoices) {
        DOM.mrduckCalChoices.classList.remove('hidden');
      }

      // Scroll morbido per rendere immediatamente visibile la scheda e i pulsanti
      setTimeout(() => {
        if (DOM.mrduckReminderCard) {
          DOM.mrduckReminderCard.scrollIntoView({ behavior: 'smooth', block: 'center' });
        }
      }, 80);

      this.updateStatus('Promemoria pronto! Tocca "📅 Aggiungi al Calendario" ✨');

      // 4. Risposta audio e visiva di Mr.Duck
      this.showDuckReply(`🦆 Ho preparato il promemoria: "${reminder.title}" per ${reminder.humanDate}! Tocca il pulsante per aggiungerlo al tuo calendario.`);
      audio.playQuack(true);
      audio.vibrate([40, 20, 60]);

      // 5. Apertura immediata se richiesta esplicitamente
      if (shouldOpenCalendar) {
        audio.playArcadeCoin();
        openCalendarEvent(reminder.title, reminder.startDate, reminder.endDate, 'auto');
        this.updateStatus('Apertura Calendario in corso... 📅✨');
      }
    }

    finalizeAndSaveToCalendar() {
      this.finalizeAndSend(null, true);
    }

    updateStatus(text) {
      if (DOM.mrduckStatus) {
        DOM.mrduckStatus.textContent = text;
      }
    }

    renderTranscript(finalText, interimText = '', placeholder = '') {
      if (!DOM.mrduckTranscript) return;

      if (!finalText && !interimText) {
        DOM.mrduckTranscript.innerHTML = `<span class="transcript-placeholder">${placeholder || 'In attesa della tua voce... parla pure al microfono!'}</span>`;
        return;
      }

      let html = '';
      if (finalText) {
        html += `<span class="transcript-final">${this.escapeHtml(finalText)}</span>`;
      }
      if (interimText) {
        html += ` <span class="transcript-interim">${this.escapeHtml(interimText)}...</span>`;
      }
      DOM.mrduckTranscript.innerHTML = html;
      DOM.mrduckTranscript.scrollTop = DOM.mrduckTranscript.scrollHeight;
    }

    escapeHtml(str) {
      return String(str)
        .split('&').join('&amp;')
        .split('<').join('&lt;')
        .split('>').join('&gt;')
        .split('"').join('&quot;');
    }

    handleUserSpokenSentence(sentence) {
      const lower = sentence.toLowerCase().trim();
      let reply = '';

      if (lower.includes('quack') || lower.includes('qua qua')) {
        reply = '🦆 QUACK QUACK!! Parli la mia lingua! Ti assegno 50 piume virtuali di rispetto!';
      } else if (lower.includes('ciao') || lower.includes('salve') || lower.includes('buongiorno') || lower.includes('buonasera')) {
        reply = '🦆 Ciao cacciatore! Sono Mr.Duck, la mascotte di CarminelloLab! Pronto alla caccia a 360°?';
      } else if (lower.includes('chi sei') || lower.includes('cosa fai')) {
        reply = '🦆 Sono Mr.Duck, il consigliere strategico dell\'arena WebAR! Chiedimi trucchi di gioco o parla liberamente!';
      } else if (lower.includes('aiuto') || lower.includes('gioc') || lower.includes('come si') || lower.includes('regol')) {
        reply = '🦆 Regola N°1: gira il corpo a 360° e consulta il Radar tattico in basso a sinistra. Abbatti i proiettili prima che ti tolgano 100 HP!';
      } else if (lower.includes('arm') || lower.includes('rpg') || lower.includes('bazooka') || lower.includes('coltello') || lower.includes('pistol')) {
        reply = '🦆 Onde 3 e 4 portano paperelle armate di coltelli e pistole, mentre l\'Onda 5+ spara devastanti missili RPG da 45 HP! Schivali o colpiscili!';
      } else if (lower.includes('instagram') || lower.includes('tiktok') || lower.includes('social') || lower.includes('contatt')) {
        reply = '🦆 Segui @carminellolab su Instagram e TikTok! Premi il tasto Contatti per vedere le paperelle postine 3D!';
      } else if (lower.includes('classifica') || lower.includes('record') || lower.includes('punti') || lower.includes('hall of fame')) {
        reply = '🦆 Più onde completi, più alto sarà il tuo punteggio nella Hall of Fame arcade! Fai registrare il tuo nome a fine partita!';
      } else {
        reply = `🦆 Quack! Ho sentito: "${sentence}". Sei pronto a scendere nell'arena e fare strike?`;
      }

      this.showDuckReply(reply);
      audio.playQuack(true);
      audio.vibrate([40, 20, 60]);
    }

    showDuckReply(replyText) {
      if (DOM.mrduckReplyBox && DOM.mrduckReplyText) {
        DOM.mrduckReplyText.textContent = replyText;
        DOM.mrduckReplyBox.classList.remove('hidden');
      }
    }
  }

  // =========================================================================
  // 10. CONTROLLER & APPLICAZIONE PRINCIPALE WebAR 360° (WAVE SURVIVAL)
  // =========================================================================
  class DuckHunt360App {
    constructor() {
      this.THREE = window.THREE;
      this.renderer = null;
      this.scene = null;
      this.camera = null;

      this.ambientLight = null;
      this.sunLight = null;
      this.rimLight = null;

      this.cameraEuler = new this.THREE.Euler(0, 0, 0, 'YXZ');
      this.deviceQuaternion = new this.THREE.Quaternion();
      this.recenterQuaternion = new this.THREE.Quaternion();
      this.zee = new this.THREE.Vector3(0, 0, 1);
      this.q0 = new this.THREE.Quaternion();
      this.q1 = new this.THREE.Quaternion(-Math.sqrt(0.5), 0, 0, Math.sqrt(0.5));

      this.lastCameraEuler = new this.THREE.Euler(0, 0, 0, 'YXZ');
      this.angularVelocity = new this.THREE.Vector2(0, 0);

      this.yawOffset = 0;

      // Entità di gioco & Pools
      this.fpsGun = null;
      this.ducks = [];
      this.dyingDucks = [];
      this.hittableColliders = [];
      this.particles = null;
      this.smokeSystem = null;
      this.scorePopups3D = null;
      this.projectilesMgr = null;

      this.raycaster = new this.THREE.Raycaster();

      // Touch drag fallback controls
      this.isDragging = false;
      this.pointerPrev = { x: 0, y: 0 };
      this.manualYaw = 0;
      this.manualPitch = 0;

      this.lastFrameTime = performance.now();
      this.isTabPaused = false;
      this.isGameManualPaused = false;
      this.gyroCheckTimeout = null;

      // --- DINAMICHE WAVE SURVIVAL ---
      this.cameraShakeIntensity = 0;
      this.aliveDucksInWave = 0;
      this.isWaveTransitioning = false;

      // --- COMPUTER VISION: TENSORFLOW.JS & COCO-SSD ---
      this.detectorModel = null;
      this.isDetectorLoading = false;
      this.isDetecting = false;
      this.detectionInterval = null;
      this.lastPerchTime = 0;
      this.alertTimeout = null;

      this.scanCanvas = document.createElement('canvas');
      this.scanCtx = this.scanCanvas.getContext('2d', { willReadFrequently: true });
      this.scanCanvas.width = 320;
      this.scanCanvas.height = 240;

      // --- CLASSIFICA ARCADE 90'S ---
      this.leaderboardMgr = new LeaderboardManager();
      this.hasSavedScoreThisRound = false;

      // --- MODALITÀ CONTATTI 3D SOCIAL ---
      this.contactsDucks = [];
      this.contactsSpawnTimeout = null;

      // --- ASSISTENTE VOCALE MR.DUCK ---
      this.mrDuckAssistant = new MrDuckVoiceAssistant();
    }

    init() {
      if (DOM.bottomDock) DOM.bottomDock.classList.remove('hidden');
      this.bindDOMEvents();
      this.setupVisibilityHandler();
      this.initObjectDetector();
    }

    async initObjectDetector() {
      if (this.detectorModel || this.isDetectorLoading) return;
      if (typeof cocoSsd === 'undefined') return;

      this.isDetectorLoading = true;
      try {
        this.detectorModel = await cocoSsd.load({ base: 'lite_mobilenet_v2' });
      } catch (err) {
        console.warn('[AI Vision] Errore caricamento:', err);
      } finally {
        this.isDetectorLoading = false;
      }
    }

    startObjectDetectionLoop() {
      this.stopObjectDetectionLoop();
      this.detectionInterval = setInterval(() => {
        this.scanCameraFeed();
      }, 350);
    }

    stopObjectDetectionLoop() {
      if (this.detectionInterval) {
        clearInterval(this.detectionInterval);
        this.detectionInterval = null;
      }
      this.isDetecting = false;
      if (DOM.hudObjectAlert) DOM.hudObjectAlert.classList.add('hidden');
    }

    async scanCameraFeed() {
      if (!GAME_STATE.isPlaying || !this.detectorModel || this.isDetecting || this.isTabPaused) {
        return;
      }

      const video = DOM.cameraFeed;
      if (!video || video.readyState < 2 || video.paused || video.ended) {
        return;
      }

      const now = performance.now();
      if (now - this.lastPerchTime < 2500) {
        return;
      }

      const availableDuck = this.ducks.find(d => d.alive && d.state === 'PATROL');
      if (!availableDuck) {
        return;
      }

      this.isDetecting = true;
      try {
        const vW = video.videoWidth || 640;
        const vH = video.videoHeight || 480;
        const scanW = 320;
        const scanH = Math.round((vH / vW) * scanW) || 240;

        if (this.scanCanvas.width !== scanW || this.scanCanvas.height !== scanH) {
          this.scanCanvas.width = scanW;
          this.scanCanvas.height = scanH;
        }

        this.scanCtx.drawImage(video, 0, 0, scanW, scanH);
        const predictions = await this.detectorModel.detect(this.scanCanvas);
        this.handlePredictions(predictions, scanW, scanH, availableDuck);
      } catch (err) {
        console.warn('[AI Vision] Errore scan:', err);
      } finally {
        this.isDetecting = false;
      }
    }

    handlePredictions(predictions, scanW, scanH, duck) {
      if (!predictions || predictions.length === 0 || !duck || !duck.alive) return;

      let bestMatch = null;
      let bestScore = 0.50;

      for (let i = 0; i < predictions.length; i++) {
        const p = predictions[i];
        if (TARGET_OBJECTS[p.class] && p.score > bestScore) {
          bestMatch = p;
          bestScore = p.score;
        }
      }

      if (!bestMatch) return;

      const cx = bestMatch.bbox[0] + bestMatch.bbox[2] * 0.5;
      const cy = bestMatch.bbox[1] + bestMatch.bbox[3] * 0.5;

      const ndcX = (cx / scanW) * 2 - 1;
      const ndcY = -((cy / scanH) * 2 - 1);

      _v1.set(ndcX, ndcY, 0.5);
      _v1.unproject(this.camera);
      _v1.sub(this.camera.position).normalize();

      const bboxAreaRatio = (bestMatch.bbox[2] * bestMatch.bbox[3]) / (scanW * scanH);
      const targetDist = Math.max(1.8, Math.min(3.2, 3.2 - bboxAreaRatio * 2.5));

      _v2.copy(this.camera.position).addScaledVector(_v1, targetDist);

      duck.state = 'PERCH';
      duck.targetObject = bestMatch.class;
      duck.targetObjectName = TARGET_OBJECTS[bestMatch.class] || 'OGGETTO';
      duck.perchTarget.copy(_v2);
      duck.perchTimer = 5.0;
      duck.isPerchedBonus = true;

      this.lastPerchTime = performance.now();
      this.showObjectAlert(duck.targetObjectName);
    }

    showObjectAlert(objectName) {
      if (!DOM.hudObjectAlert || !DOM.hudObjectText) return;
      DOM.hudObjectText.textContent = `🦆 PAPERA APPOLLAIATA SULLA ${objectName}! (2X PUNTI)`;
      DOM.hudObjectAlert.classList.remove('hidden');

      if (this.alertTimeout) clearTimeout(this.alertTimeout);
      this.alertTimeout = setTimeout(() => {
        if (DOM.hudObjectAlert) DOM.hudObjectAlert.classList.add('hidden');
      }, 3500);
    }

    toggleGamePause() {
      if (!GAME_STATE.isPlaying) return;
      this.isGameManualPaused = !this.isGameManualPaused;
      if (this.isGameManualPaused) {
        audio.playQuack();
        this.updateDockGameButton('▶️', 'Riprendi');
      } else {
        audio.playArcadeCoin();
        this.lastFrameTime = performance.now();
        this.updateDockGameButton('⏸️', 'Pausa');
      }
    }

    updateDockGameButton(icon, label) {
      // Metodo mantenuto per compatibilità di chiamata
    }

    bindDOMEvents() {
      // --- EVENTI FLOATING BOTTOM DOCK (iOS Thumb Zone) ---
      if (DOM.bottomDock) {
        ['click', 'touchstart', 'touchend', 'pointerdown', 'pointerup', 'mousedown'].forEach(evtName => {
          DOM.bottomDock.addEventListener(evtName, (e) => {
            e.stopPropagation();
          }, { passive: false });
        });
      }

      const launchGameHandler = (e) => {
        if (e) e.stopPropagation();
        audio.init();

        let gyroPermissionPromise = null;
        if (typeof DeviceOrientationEvent !== 'undefined' &&
            typeof DeviceOrientationEvent.requestPermission === 'function') {
          try {
            gyroPermissionPromise = DeviceOrientationEvent.requestPermission();
          } catch (err) {
            console.warn('Errore sincrono richiesta permessi iOS:', err);
          }
        }
        this.startExperienceWithPermissions(gyroPermissionPromise);
      };

      // Tasto Gioca nella Scheda Principale
      if (DOM.btnStartGame) {
        DOM.btnStartGame.addEventListener('click', launchGameHandler);
      }

      // Tasto HERO Sinistro Dock: Mr.Duck Assistente Vocale
      if (DOM.btnDockMrduck) {
        DOM.btnDockMrduck.addEventListener('click', (e) => {
          e.stopPropagation();
          audio.init();
          audio.playArcadeCoin();
          if (this.mrDuckAssistant) {
            this.mrDuckAssistant.open();
          }
        });
      }

      // Tasto Destro: Social / Contatti 3D
      if (DOM.btnDockContacts) {
        DOM.btnDockContacts.addEventListener('click', (e) => {
          e.stopPropagation();
          audio.init();
          audio.playArcadeCoin();

          if (GAME_STATE.isContactsMode) {
            this.closeContactsExperience();
          } else {
            let gyroPermissionPromise = null;
            if (typeof DeviceOrientationEvent !== 'undefined' &&
                typeof DeviceOrientationEvent.requestPermission === 'function') {
              try {
                gyroPermissionPromise = DeviceOrientationEvent.requestPermission();
              } catch (err) {}
            }
            this.startContactsExperience(gyroPermissionPromise);
          }
        });
      }

      if (DOM.btnCloseContacts) {
        DOM.btnCloseContacts.addEventListener('click', () => {
          this.closeContactsExperience();
        });
      }

      // Click sui pulsanti spuntati dalle scatole
      if (DOM.boxButtonInstagram) {
        DOM.boxButtonInstagram.addEventListener('click', (e) => {
          e.stopPropagation();
          audio.init();
          audio.playArcadeCoin();
          audio.vibrate([40, 20, 60]);
          window.open(CONFIG.instagramUrl, '_blank', 'noopener,noreferrer');
        });
      }

      if (DOM.boxButtonTiktok) {
        DOM.boxButtonTiktok.addEventListener('click', (e) => {
          e.stopPropagation();
          audio.init();
          audio.playArcadeCoin();
          audio.vibrate([40, 20, 60]);
          window.open(CONFIG.tiktokUrl, '_blank', 'noopener,noreferrer');
        });
      }

      DOM.btnPlayAgain.addEventListener('click', () => {
        DOM.gameOverOverlay.classList.add('hidden');
        this.startGameSession();
      });

      if (DOM.btnGameOverMenu) {
        DOM.btnGameOverMenu.addEventListener('click', () => {
          audio.init();
          audio.playArcadeCoin();
          DOM.gameOverOverlay.classList.add('hidden');
          DOM.startOverlay.classList.remove('hidden');
          if (DOM.bottomDock) DOM.bottomDock.classList.remove('hidden');
          this.isGameManualPaused = false;
          this.updateDockGameButton('🎮', 'Gioca');
        });
      }

      // Protezione attiva sui link social di Game Over contro tap accidentali post-morte
      document.querySelectorAll('.game-over-social-row a').forEach(link => {
        link.addEventListener('click', (e) => {
          if (this.isDefeatTapShieldActive) {
            e.preventDefault();
            e.stopPropagation();
            return false;
          }
        });
      });

      // --- EVENTI CLASSIFICA ARCADE ---
      if (DOM.btnViewLeaderboard) {
        DOM.btnViewLeaderboard.addEventListener('click', () => {
          audio.init();
          audio.playArcadeCoin();
          this.openLeaderboard();
        });
      }

      if (DOM.btnStartLeaderboard) {
        DOM.btnStartLeaderboard.addEventListener('click', () => {
          audio.init();
          audio.playArcadeCoin();
          this.openLeaderboard();
        });
      }

      if (DOM.btnCloseLeaderboard) {
        DOM.btnCloseLeaderboard.addEventListener('click', () => {
          DOM.leaderboardOverlay.classList.add('hidden');
          if (DOM.bottomDock && !GAME_STATE.isPlaying && !GAME_STATE.isContactsMode) {
            DOM.bottomDock.classList.remove('hidden');
          }
        });
      }

      if (DOM.leaderboardOverlay) {
        DOM.leaderboardOverlay.addEventListener('click', (e) => {
          if (e.target === DOM.leaderboardOverlay) {
            DOM.leaderboardOverlay.classList.add('hidden');
            if (DOM.bottomDock && !GAME_STATE.isPlaying && !GAME_STATE.isContactsMode) {
              DOM.bottomDock.classList.remove('hidden');
            }
          }
        });
      }

      if (DOM.btnCloseMrduck) {
        DOM.btnCloseMrduck.addEventListener('click', () => {
          if (this.mrDuckAssistant) {
            this.mrDuckAssistant.close();
          }
        });
      }

      if (DOM.mrduckMicBtn) {
        DOM.mrduckMicBtn.addEventListener('click', () => {
          if (this.mrDuckAssistant) {
            this.mrDuckAssistant.toggleListening();
          }
        });
      }

      if (DOM.btnMrduckCalendar) {
        DOM.btnMrduckCalendar.addEventListener('click', () => {
          if (this.mrDuckAssistant && this.mrDuckAssistant.currentReminder) {
            audio.init();
            audio.playArcadeCoin();
            const r = this.mrDuckAssistant.currentReminder;
            openCalendarEvent(r.title, r.startDate, r.endDate, 'auto');
            this.mrDuckAssistant.updateStatus('Evento aperto nel Calendario! 📅✨');
          }
        });
      }

      if (DOM.btnMrduckGcal) {
        DOM.btnMrduckGcal.addEventListener('click', () => {
          audio.init();
          audio.playArcadeCoin();
          if (this.mrDuckAssistant) {
            this.mrDuckAssistant.updateStatus('Apertura Google Calendar... 📅');
          }
        });
      }

      if (DOM.btnMrduckApple) {
        DOM.btnMrduckApple.addEventListener('click', () => {
          audio.init();
          audio.playArcadeCoin();
          const ua = navigator.userAgent || '';
          const isIOS = /iPad|iPhone|iPod/.test(ua) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
          if (isIOS && this.mrDuckAssistant && this.mrDuckAssistant.currentReminder) {
            const r = this.mrDuckAssistant.currentReminder;
            openCalendarEvent(r.title, r.startDate, r.endDate, 'apple');
          }
          if (this.mrDuckAssistant) {
            this.mrDuckAssistant.updateStatus('Apertura Apple Calendar... 🍎');
          }
        });
      }

      if (DOM.btnMrduckDone) {
        DOM.btnMrduckDone.addEventListener('click', () => {
          audio.init();
          audio.playArcadeCoin();
          if (this.mrDuckAssistant) {
            this.mrDuckAssistant.close();
          }
        });
      }

      if (DOM.btnMrduckRetry) {
        DOM.btnMrduckRetry.addEventListener('click', () => {
          if (this.mrDuckAssistant) {
            this.mrDuckAssistant.retryListening();
          }
        });
      }

      if (DOM.mrduckModal) {
        DOM.mrduckModal.addEventListener('click', (e) => {
          if (e.target === DOM.mrduckModal) {
            if (this.mrDuckAssistant) {
              this.mrDuckAssistant.close();
            }
          }
        });
      }

      // Chip di suggerimento per Mr.Duck
      document.querySelectorAll('.hint-tag').forEach(tag => {
        tag.addEventListener('click', (e) => {
          const phrase = e.currentTarget.getAttribute('data-say') || e.currentTarget.textContent.split('"').join('');
          if (this.mrDuckAssistant) {
            this.mrDuckAssistant.isSending = false;
            this.mrDuckAssistant.manualStop = false;
            this.mrDuckAssistant.renderTranscript(phrase);
            this.mrDuckAssistant.finalizeAndSend(phrase);
          }
        });
      });

      if (DOM.btnSaveScore) {
        DOM.btnSaveScore.addEventListener('click', () => {
          this.saveCurrentPlayerScore();
        });
      }

      if (DOM.arcadeInputName) {
        DOM.arcadeInputName.addEventListener('input', (e) => {
          e.target.value = e.target.value.toUpperCase().replace(/[^A-Z0-9_]/g, '');
        });
        DOM.arcadeInputName.addEventListener('keydown', (e) => {
          if (e.key === 'Enter') {
            e.preventDefault();
            this.saveCurrentPlayerScore();
          }
        });
      }

      DOM.btnAudio.addEventListener('click', () => {
        GAME_STATE.soundEnabled = !GAME_STATE.soundEnabled;
        DOM.iconSoundOn.classList.toggle('hidden', !GAME_STATE.soundEnabled);
        DOM.iconSoundOff.classList.toggle('hidden', GAME_STATE.soundEnabled);
        if (GAME_STATE.soundEnabled) audio.init();
      });

      DOM.btnRecenter.addEventListener('click', () => {
        this.recenterHeading();
      });

      if (DOM.btnExitGame) {
        DOM.btnExitGame.addEventListener('click', (e) => {
          e.stopPropagation();
          audio.init();
          audio.playArcadeCoin();
          this.exitGameSession();
        });
      }

      DOM.btnFire.addEventListener('click', (e) => {
        e.stopPropagation();
        this.fireShotgun();
      });

      window.addEventListener('pointerdown', (e) => {
        if (e.target.closest('button') || e.target.closest('a') || e.target.closest('.modal-card') || e.target.closest('.hud-topbar') || e.target.closest('.contacts-hud') || e.target.closest('.bottom-dock')) {
          return;
        }
        if (GAME_STATE.isPlaying && !this.isGameManualPaused) {
          this.fireShotgun();
        } else if (GAME_STATE.isContactsMode) {
          this.checkSocialDuckClick(e);
        }
      });
    }

    async startExperienceWithPermissions(gyroPermissionPromise) {
      DOM.startOverlay.classList.add('hidden');

      if (gyroPermissionPromise) {
        try {
          const permResult = await gyroPermissionPromise;
          if (permResult === 'granted') {
            this.listenToDeviceOrientation();
          } else {
            this.enableFallbackDragControls();
          }
        } catch (err) {
          this.enableFallbackDragControls();
        }
      } else {
        this.listenToDeviceOrientation();
      }

      await this.initCameraPassThrough();
      this.setup3DScene();
      this.startGameSession();

      this.gyroCheckTimeout = setTimeout(() => {
        if (!GAME_STATE.gyroActive) {
          this.enableFallbackDragControls();
        }
      }, 1000);
    }

    async initCameraPassThrough() {
      try {
        if (navigator.mediaDevices && navigator.mediaDevices.getUserMedia) {
          const stream = await navigator.mediaDevices.getUserMedia({
            video: { facingMode: { ideal: "environment" } },
            audio: false
          });

          DOM.cameraFeed.srcObject = stream;
          DOM.cameraFeed.play().catch(err => {
            console.warn('Camera feed autoplay warning:', err);
          });
        }
      } catch (err) {
        console.warn('Fotocamera non disponibile:', err);
      }
    }

    listenToDeviceOrientation() {
      const handleOrientation = (e) => {
        if (e.alpha !== null && e.beta !== null && e.gamma !== null) {
          GAME_STATE.hasGyro = true;
          GAME_STATE.gyroActive = true;
          GAME_STATE.gyroAlpha = e.alpha;
          GAME_STATE.gyroBeta = e.beta;
          GAME_STATE.gyroGamma = e.gamma;
        }
      };

      window.addEventListener('deviceorientation', handleOrientation, true);
      window.addEventListener('orientationchange', () => {
        GAME_STATE.screenOrientation = window.orientation || 0;
        this.handleResize();
      });
    }

    enableFallbackDragControls() {
      const onDown = (x, y) => {
        this.isDragging = true;
        this.pointerPrev = { x, y };
      };

      const onMove = (x, y) => {
        if (!this.isDragging) return;
        const dx = x - this.pointerPrev.x;
        const dy = y - this.pointerPrev.y;

        this.manualYaw -= dx * 0.0035;
        this.manualPitch = Math.max(-1.45, Math.min(1.45, this.manualPitch - dy * 0.0035));
        this.pointerPrev = { x, y };
      };

      const onUp = () => {
        this.isDragging = false;
      };

      window.addEventListener('mousedown', (e) => onDown(e.clientX, e.clientY));
      window.addEventListener('mousemove', (e) => onMove(e.clientX, e.clientY));
      window.addEventListener('mouseup', onUp);

      window.addEventListener('touchstart', (e) => {
        if (e.touches.length === 1) onDown(e.touches[0].clientX, e.touches[0].clientY);
      }, { passive: true });

      window.addEventListener('touchmove', (e) => {
        if (e.touches.length === 1) onMove(e.touches[0].clientX, e.touches[0].clientY);
      }, { passive: true });

      window.addEventListener('touchend', onUp);
    }

    recenterHeading() {
      if (GAME_STATE.hasGyro && GAME_STATE.gyroActive) {
        _v1.set(0, 0, -1).applyQuaternion(this.deviceQuaternion);
        this.yawOffset = -Math.atan2(_v1.x, -_v1.z);
      } else {
        this.manualYaw = 0;
        this.manualPitch = 0;
      }
      audio.vibrate([30]);
    }

    setupVisibilityHandler() {
      document.addEventListener('visibilitychange', () => {
        if (document.hidden) {
          this.isTabPaused = true;
        } else {
          this.isTabPaused = false;
          this.lastFrameTime = performance.now();
        }
      });
    }

    setup3DScene() {
      if (this.renderer) return;
      const THREE = this.THREE;

      this.renderer = new THREE.WebGLRenderer({
        antialias: true,
        alpha: true,
        powerPreference: 'high-performance'
      });
      this.renderer.setSize(window.innerWidth, window.innerHeight);
      this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));

      this.renderer.outputEncoding = THREE.sRGBEncoding;
      this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
      this.renderer.toneMappingExposure = 1.25;

      DOM.container.appendChild(this.renderer.domElement);

      this.scene = new THREE.Scene();
      this.camera = new THREE.PerspectiveCamera(65, window.innerWidth / window.innerHeight, 0.05, 100);
      this.camera.position.set(0, 0, 0);
      this.scene.add(this.camera);

      this.ambientLight = new THREE.AmbientLight(0xD8E8F8, 0.85);
      this.scene.add(this.ambientLight);

      this.sunLight = new THREE.DirectionalLight(0xFFF4E0, 1.65);
      this.sunLight.position.set(2.5, 4.5, 2.0);
      this.scene.add(this.sunLight);

      this.rimLight = new THREE.DirectionalLight(0x7090FF, 0.9);
      this.rimLight.position.set(-2.5, 3.0, -3.5);
      this.scene.add(this.rimLight);

      this.fpsGun = createClassicHuntingShotgun(THREE);
      this.camera.add(this.fpsGun.gun);

      this.smokeSystem = new BarrelSmokeSystem(THREE, 20);
      this.scene.add(this.smokeSystem.group);

      this.particles = createParticleEngine(THREE, 240);
      this.scene.add(this.particles.group);

      this.scorePopups3D = new ScorePopups3DSystem(THREE, 8);
      this.scene.add(this.scorePopups3D.group);

      this.projectilesMgr = new ProjectilesManager(THREE, this.scene);

      window.addEventListener('resize', () => this.handleResize());
      window.addEventListener('orientationchange', () => {
        setTimeout(() => this.handleResize(), 80);
      });

      this.lastFrameTime = performance.now();
      this.renderer.setAnimationLoop(() => {
        const now = performance.now();
        if (this.isTabPaused || this.isGameManualPaused) {
          this.lastFrameTime = now;
          this.renderer.render(this.scene, this.camera);
          return;
        }
        const dt = Math.min((now - this.lastFrameTime) / 1000, 0.1);
        this.lastFrameTime = now;

        this.gameLoop(dt);
        this.renderer.render(this.scene, this.camera);
      });
    }

    handleResize() {
      if (!this.renderer || !this.camera) return;
      const width = window.innerWidth;
      const height = window.innerHeight;

      this.renderer.setSize(width, height);
      this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));

      this.camera.aspect = width / height;
      this.camera.updateProjectionMatrix();
    }

    /**
     * Avvia una nuova sessione Wave Survival
     */
    startGameSession() {
      this.clearSocialDeliveryDucks();
      if (DOM.contactsHud) DOM.contactsHud.classList.add('hidden');
      if (DOM.gameOverOverlay) DOM.gameOverOverlay.classList.add('hidden');
      if (DOM.startOverlay) DOM.startOverlay.classList.add('hidden');
      if (this.fpsGun && this.fpsGun.gun) this.fpsGun.gun.visible = true;
      GAME_STATE.isContactsMode = false;
      this.isGameManualPaused = false;

      GAME_STATE.isPlaying = true;
      GAME_STATE.score = 0;
      GAME_STATE.level = 1;
      GAME_STATE.hp = 100;
      GAME_STATE.maxHp = 100;
      GAME_STATE.totalDamageTaken = 0;
      GAME_STATE.ducksHit = 0;
      GAME_STATE.totalShots = 0;
      GAME_STATE.combo = 1;
      GAME_STATE.comboTimer = 0;
      this.cameraShakeIntensity = 0;
      this.isWaveTransitioning = false;
      this.isGameManualPaused = false;

      // Nascondi completamente la bottom dock durante il minigioco FPS
      if (DOM.bottomDock) DOM.bottomDock.classList.add('hidden');
      if (DOM.btnExitGame) DOM.btnExitGame.classList.remove('hidden');

      DOM.gameStatsBar.classList.remove('hidden');
      DOM.hudBottom.classList.remove('hidden');
      DOM.crosshair.classList.remove('hidden');
      if (DOM.radarContainer) DOM.radarContainer.classList.remove('hidden');

      this.startWave(1);
      audio.vibrate([40, 30, 60]);
      this.startObjectDetectionLoop();
    }

    /**
     * Uscita dal minigioco e ritorno al menu principale
     */
    exitGameSession() {
      this.stopObjectDetectionLoop();
      GAME_STATE.isPlaying = false;
      this.isGameManualPaused = false;

      this.ducks.forEach(d => {
        if (d.mesh.parent) d.mesh.parent.remove(d.mesh);
      });
      this.ducks = [];
      this.dyingDucks = [];
      this.hittableColliders = [];
      if (this.projectilesMgr) this.projectilesMgr.clear();

      DOM.gameStatsBar.classList.add('hidden');
      DOM.hudBottom.classList.add('hidden');
      DOM.crosshair.classList.add('hidden');
      DOM.waveBanner.classList.add('hidden');
      if (DOM.radarContainer) DOM.radarContainer.classList.add('hidden');
      if (DOM.btnExitGame) DOM.btnExitGame.classList.add('hidden');
      this.clearRadar();

      DOM.startOverlay.classList.remove('hidden');
      if (DOM.bottomDock) DOM.bottomDock.classList.remove('hidden');
      this.updateDockGameButton('🎮', 'Gioca');
    }

    /**
     * Configura e spawna l'ondata specificata
     */
    startWave(level) {
      this.ducks.forEach(d => {
        if (d.mesh.parent) d.mesh.parent.remove(d.mesh);
      });
      this.ducks = [];
      this.dyingDucks = [];
      this.hittableColliders = [];
      if (this.projectilesMgr) this.projectilesMgr.clear();

      const config = (level <= WAVE_CONFIG.length)
        ? WAVE_CONFIG[level - 1]
        : {
            level,
            name: `ONDATA INFERNALE ${level}`,
            duckCount: 14 + (level - 5) * 2,
            weapon: 'mixed',
            canAttack: true,
            attackType: 'mixed',
            speed: 2.2,
            damage: 25,
            attackCooldownMin: 3.0,
            attackCooldownMax: 5.5
          };

      this.aliveDucksInWave = config.duckCount;

      for (let i = 0; i < config.duckCount; i++) {
        let duckCfg = config;
        if (config.weapon === 'mixed') {
          const arsenal = ['knife', 'pistol', 'rpg'];
          const chosen = arsenal[i % arsenal.length];
          duckCfg = Object.assign({}, config, {
            weapon: chosen,
            attackType: (chosen === 'knife' ? 'knife_zigzag' : (chosen === 'pistol' ? 'shoot_bullet' : 'shoot_rocket')),
            damage: (chosen === 'knife' ? 20 : (chosen === 'pistol' ? 15 : 45)),
            speed: (chosen === 'knife' ? 2.6 : (chosen === 'pistol' ? 1.2 : 1.0))
          });
        }
        this.spawnDuck(duckCfg);
      }

      this.updateHUDStats();
    }

    /**
     * Spawna una paperella con parametri specifici dell'ondata
     */
    spawnDuck(waveConfig) {
      const THREE = this.THREE;
      const types = ['goofy', 'goofy', 'cool', 'derpy', 'king'];
      const type = types[Math.floor(Math.random() * types.length)];
      const mesh = createFunnyYellowDuck(THREE, type, waveConfig.weapon);

      const distance = 3.6 + Math.random() * 3.8;
      const theta = Math.random() * Math.PI * 2;
      const phi = (Math.random() - 0.5) * (Math.PI * 0.42);

      mesh.position.set(
        Math.cos(phi) * Math.sin(theta) * distance,
        Math.sin(phi) * distance + 0.2,
        Math.cos(phi) * Math.cos(theta) * distance
      );

      mesh.lookAt(0, mesh.position.y, 0);
      this.scene.add(mesh);

      const attackCooldownMin = waveConfig.attackCooldownMin || 4.0;
      const attackCooldownMax = waveConfig.attackCooldownMax || 7.0;

      const duckData = {
        mesh,
        type,
        distance,
        theta,
        phi,
        speedTheta: (0.16 + Math.random() * 0.36) * (Math.random() > 0.5 ? 1 : -1),
        bobSpeed: 2.2 + Math.random() * 2.0,
        bobHeight: 0.25 + Math.random() * 0.35,
        alive: true,

        // FSM Nemica
        state: 'PATROL', // PATROL, ATTACK_APPROACH, FIRE_PREPARE, PERCH, DIE
        weapon: waveConfig.weapon,
        canAttack: waveConfig.canAttack,
        attackType: waveConfig.attackType,
        attackSpeed: waveConfig.speed || 2.0,
        damage: waveConfig.damage || 10,
        attackCooldownMin,
        attackCooldownMax,
        attackCooldown: attackCooldownMin + Math.random() * (attackCooldownMax - attackCooldownMin),
        zigzagPhase: Math.random() * Math.PI * 2,
        firePrepTimer: 0,

        // AI Perching su oggetti
        perchTarget: new THREE.Vector3(),
        perchTimer: 0,
        targetObject: null,
        targetObjectName: null,
        isPerchedBonus: false
      };

      const collider = mesh.userData.hitCollider;
      collider.userData.duckData = duckData;

      this.ducks.push(duckData);
      this.hittableColliders.push(collider);
    }

    /**
     * Micro-scuotimento cinetico telecamera Three.js (Screen Shake con decadimento rapido)
     */
    screenShake(intensity = 0.06, duration = 120) {
      this.cameraShakeIntensity = Math.min(0.35, Math.max(this.cameraShakeIntensity, intensity));
    }

    /**
     * Mostra Hitmarker FPS dinamico ("X" rapida bianco per normale, rosso/oro per critico)
     */
    showHitmarker(isCrit = false) {
      if (!DOM.crosshairHitmarker) return;
      DOM.crosshairHitmarker.className = 'crosshair-hitmarker ' + (isCrit ? 'hit-crit' : 'hit');
      audio.playHitmarker(isCrit);
      if (this.hitmarkerTimeout) clearTimeout(this.hitmarkerTimeout);
      this.hitmarkerTimeout = setTimeout(() => {
        if (DOM.crosshairHitmarker) DOM.crosshairHitmarker.className = 'crosshair-hitmarker';
      }, 120);
    }

    /**
     * Bagliore perimetrale a bordo schermo (Vignette Glow: bianco, oro o rosso danno)
     */
    triggerVignetteGlow(type = 'hit-white', duration = 140) {
      if (!DOM.hitVignette) return;
      DOM.hitVignette.className = `hit-vignette ${type}`;
      if (this.vignetteTimeout) clearTimeout(this.vignetteTimeout);
      this.vignetteTimeout = setTimeout(() => {
        if (DOM.hitVignette) DOM.hitVignette.className = 'hit-vignette';
      }, duration);
    }

    /**
     * Sistema di Sparo e Raycast su Paperelle & Proiettili Nemici Intercettabili
     */
    fireShotgun() {
      const now = performance.now();
      if (now - GAME_STATE.lastFireTime < 180) return;
      GAME_STATE.lastFireTime = now;
      GAME_STATE.totalShots++;

      audio.playShotgun();

      // Animazione di rinculo/spread del mirino (si allarga e si richiude in 100ms)
      if (DOM.crosshair) {
        DOM.crosshair.classList.add('recoil');
        setTimeout(() => {
          if (DOM.crosshair) DOM.crosshair.classList.remove('recoil');
        }, 100);
      }

      if (this.fpsGun) {
        this.fpsGun.recoilZ = 0.095;
        this.fpsGun.recoilRotX = -0.28;
        this.fpsGun.flashSprite.material.rotation = Math.random() * Math.PI * 2;
        this.fpsGun.flashSprite.visible = true;
        this.fpsGun.muzzleLight.intensity = 5.5;

        setTimeout(() => {
          if (this.fpsGun) this.fpsGun.flashSprite.visible = false;
        }, 70);

        if (this.smokeSystem) {
          _v1.set(0, 0.015, -this.fpsGun.barrelLength - 0.05);
          this.fpsGun.gun.localToWorld(_v1);
          this.smokeSystem.emit(_v1, 4);
        }
      }

      DOM.muzzleFlash.classList.add('active');
      setTimeout(() => DOM.muzzleFlash.classList.remove('active'), 60);

      this.raycaster.setFromCamera(_screenCenter, this.camera);

      // Raycast combinato su paperelle e proiettili/razzi intercettabili!
      const targetsPool = [...this.hittableColliders, ...this.projectilesMgr.hittableColliders];
      const intersects = this.raycaster.intersectObjects(targetsPool, false);

      if (intersects.length > 0) {
        const hitObj = intersects[0].object;

        // 1. Proiettile nemico intercettato!
        if (hitObj.userData.projectileData) {
          this.handleProjectileIntercept(hitObj.userData.projectileData, intersects[0].point);
        }
        // 2. Paperella colpita
        else if (hitObj.userData.duckData) {
          const duckData = hitObj.userData.duckData;
          if (duckData && duckData.alive) {
            this.handleDuckHit(duckData, intersects[0].point);
          }
        }
      } else {
        // Tocco a vuoto: azzera la combo a x1
        GAME_STATE.combo = 1;
        this.updateHUDStats();
      }
    }

    /**
     * Intercettazione in volo di proiettili o razzi
     */
    handleProjectileIntercept(proj, hitPoint) {
      proj.alive = false;
      const isRocket = (proj.type === 'rocket');
      const bonusPts = isRocket ? 250 : 100;
      GAME_STATE.score += bonusPts;

      // Kinetic feedback
      this.showHitmarker(isRocket);
      this.screenShake(isRocket ? 0.08 : 0.04, 120);
      this.triggerVignetteGlow(isRocket ? 'hit-gold' : 'hit-white', 120);

      if (isRocket) {
        audio.playRocketExplosion();
        this.particles.burst(hitPoint, 55, 0xFF3B00);
        this.showScorePopup(`+${bonusPts} ROCKET DEFUSED!`, hitPoint, 'crit');
        if (this.scorePopups3D) this.scorePopups3D.spawn(`+${bonusPts} DEFUSED!`, hitPoint, true);
      } else {
        this.particles.burst(hitPoint, 25, 0xFFAA00);
        this.showScorePopup(`+${bonusPts} BULLET DEFLECTED!`, hitPoint, 'bonus');
      }

      this.updateHUDStats();
    }

    /**
     * Risoluzione colpo su paperella e controllo completamento ondata
     */
    handleDuckHit(duck, hitPoint) {
      duck.alive = false;
      duck.state = 'DIE';
      GAME_STATE.ducksHit++;
      this.aliveDucksInWave = Math.max(0, this.aliveDucksInWave - 1);

      const colIdx = this.hittableColliders.indexOf(duck.mesh.userData.hitCollider);
      if (colIdx !== -1) {
        this.hittableColliders.splice(colIdx, 1);
      }

      const isKing = (duck.type === 'king');
      const isPerchHit = (duck.isPerchedBonus);
      audio.playQuack(isKing, isPerchHit);

      // Incremento Combo Multiplier consecutivo
      GAME_STATE.combo = Math.min(GAME_STATE.combo + 1, 8);
      GAME_STATE.comboTimer = 3.5;

      const isCrit = (isKing || isPerchHit || GAME_STATE.combo >= 3);

      // Kinetic feedback: Hitmarker, Camera Shake e Screen Vignette Flash
      this.showHitmarker(isCrit);
      this.screenShake(isCrit ? 0.08 : 0.05, 120);
      this.triggerVignetteGlow(isCrit ? 'hit-gold' : 'hit-white', 130);

      // Suono di caduta balistica
      audio.playDuckFall();

      let earned = duck.mesh.userData.points * GAME_STATE.combo;
      if (isPerchHit) earned *= 2;
      GAME_STATE.score += earned;

      const burstColor = isKing ? 0xFFD700 : (isPerchHit ? 0x00F0FF : CONFIG.colors.duckYellow);
      if (this.particles.burstFeathers) {
        this.particles.burstFeathers(duck.mesh.position, 28, burstColor);
      } else {
        this.particles.burst(duck.mesh.position, isPerchHit ? 50 : 40, burstColor);
      }

      let label = `+${earned}`;
      let popupType = 'normal';
      if (isPerchHit) {
        const objName = duck.targetObjectName || 'OGGETTO';
        label = `CRIT! +${earned} ${objName} (2X)!`;
        popupType = 'crit';
      } else if (duck.type === 'king') {
        label = `KING CRIT! +${earned}`;
        popupType = 'crit';
      } else if (GAME_STATE.combo >= 3) {
        label = `CRIT! +${earned} (x${GAME_STATE.combo})!`;
        popupType = 'crit';
      } else if (GAME_STATE.combo > 1) {
        label = `+${earned} (x${GAME_STATE.combo})!`;
        popupType = 'bonus';
      } else if (duck.type === 'cool') {
        label = `+${earned} COOL!`;
        popupType = 'bonus';
      } else if (duck.type === 'derpy') {
        label = `+${earned} DERP!`;
      }

      if (this.scorePopups3D) {
        this.scorePopups3D.spawn(label, duck.mesh.position, isCrit);
      }

      this.showScorePopup(label, duck.mesh.position, popupType);

      // FISICA DI CADUTA: disattiva volo, capovolgi a testa in giù e avvia caduta gravitazionale
      duck.mesh.rotation.z = Math.PI;
      if (duck.mesh.userData.leftWing) duck.mesh.userData.leftWing.rotation.z = -1.2;
      if (duck.mesh.userData.rightWing) duck.mesh.userData.rightWing.rotation.z = 1.2;

      this.dyingDucks.push({
        mesh: duck.mesh,
        velY: 1.2,
        gravity: 16.0,
        rotVelX: (Math.random() - 0.5) * 8,
        rotVelY: (Math.random() - 0.5) * 12,
        rotVelZ: (Math.random() - 0.5) * 8,
        featherTimer: 0,
        color: burstColor,
        scale: 1.0,
        age: 0
      });

      this.updateHUDStats();

      // Controllo vittoria dell'ondata corrente
      if (this.aliveDucksInWave === 0 && !this.isWaveTransitioning && GAME_STATE.isPlaying) {
        this.onWaveCompleted();
      }
    }

    /**
     * Transizione di livello tra un'ondata e la successiva (+20 HP bonus)
     */
    onWaveCompleted() {
      this.isWaveTransitioning = true;
      audio.playWaveSuccess();

      // Ripristino salute giocatore (+20 HP fino a 100)
      const prevHp = GAME_STATE.hp;
      GAME_STATE.hp = Math.min(100, GAME_STATE.hp + 20);
      const healed = GAME_STATE.hp - prevHp;
      this.updateHUDStats();

      DOM.waveBannerTitle.textContent = `LIVELLO ${GAME_STATE.level} COMPLETATO!`;
      DOM.waveBannerSub.textContent = `ONDATA ${GAME_STATE.level + 1} IN ARRIVO (+${healed} HP)`;
      DOM.waveBanner.classList.remove('hidden');

      setTimeout(() => {
        DOM.waveBanner.classList.add('hidden');
        this.isWaveTransitioning = false;
        if (GAME_STATE.isPlaying) {
          GAME_STATE.level++;
          this.startWave(GAME_STATE.level);
        }
      }, 3000);
    }

    /**
     * Danno subito dal giocatore con camera shake e red damage flash
     */
    takeDamage(amount, type = 'melee') {
      if (!GAME_STATE.isPlaying || GAME_STATE.hp <= 0) return;

      GAME_STATE.hp = Math.max(0, GAME_STATE.hp - amount);
      GAME_STATE.totalDamageTaken += amount;
      this.updateHUDStats();

      audio.playPlayerHit();

      // Bagliore perimetrale rosso e Damage Flash a schermo
      this.triggerVignetteGlow('hit-danger', 220);
      if (DOM.damageFlash) {
        DOM.damageFlash.classList.add('active');
        setTimeout(() => {
          if (DOM.damageFlash) DOM.damageFlash.classList.remove('active');
        }, 160);
      }

      // Camera Shake Three.js con decadimento rapido
      const intensity = (amount >= 40) ? 0.24 : (amount >= 20 ? 0.15 : 0.08);
      this.screenShake(intensity, 180);

      if (GAME_STATE.hp <= 0) {
        this.triggerDefeatSequence();
      }
    }

    /**
     * Sequenza cinematica di sconfitta con tap shield per evitare tocchi accidentali
     */
    triggerDefeatSequence() {
      if (this.isDefeatHandling) return;
      this.isDefeatHandling = true;
      GAME_STATE.isPlaying = false;
      this.isGameManualPaused = false;
      this.updateDockGameButton('🎮', 'Gioca');

      audio.playDefeatSound();

      // Lampo rosso drammatico di sconfitta
      if (DOM.damageFlash) {
        DOM.damageFlash.classList.add('defeat-pulse');
      }

      // Nascondi subito mirino e comandi di fuoco per interrompere i tap dell'utente
      if (DOM.hudBottom) DOM.hudBottom.classList.add('hidden');
      if (DOM.crosshair) DOM.crosshair.classList.add('hidden');
      if (DOM.waveBanner) DOM.waveBanner.classList.add('hidden');
      this.clearRadar();

      // Attesa protetta di 650ms per assorbire i tap in corso prima di mostrare il Game Over
      setTimeout(() => {
        if (DOM.damageFlash) {
          DOM.damageFlash.classList.remove('defeat-pulse');
        }
        this.isDefeatHandling = false;
        this.endGameSession(true);
      }, 650);
    }

    showScorePopup(text, worldPos, type = 'normal') {
      _v1.copy(worldPos).project(this.camera);
      const x = ((_v1.x + 1) / 2) * window.innerWidth;
      const y = ((-_v1.y + 1) / 2) * window.innerHeight;

      const el = document.createElement('div');
      el.className = `score-popup ${type}`;
      el.textContent = text;
      el.style.left = `${x}px`;
      el.style.top = `${y}px`;

      DOM.floatingScoresContainer.appendChild(el);
      setTimeout(() => el.remove(), 850);
    }

    updateHUDStats() {
      DOM.statScoreVal.textContent = String(GAME_STATE.score).padStart(4, '0');
      DOM.statLevelVal.textContent = String(GAME_STATE.level);
      DOM.statDucksVal.textContent = String(GAME_STATE.ducksHit);
      DOM.statComboVal.textContent = `x${GAME_STATE.combo}`;

      // Barra HP Digitale & Progressiva
      const hpPct = Math.max(0, Math.min(100, (GAME_STATE.hp / GAME_STATE.maxHp) * 100));
      DOM.statHpText.textContent = `${Math.ceil(GAME_STATE.hp)} / ${GAME_STATE.maxHp}`;
      DOM.hpBarFill.style.width = `${hpPct}%`;

      DOM.hpBarFill.classList.remove('warning', 'danger');
      if (hpPct <= 25) {
        DOM.hpBarFill.classList.add('danger');
      } else if (hpPct <= 50) {
        DOM.hpBarFill.classList.add('warning');
      }
    }

    endGameSession(isDefeat = false) {
      GAME_STATE.isPlaying = false;
      this.stopObjectDetectionLoop();
      if (this.projectilesMgr) this.projectilesMgr.clear();

      DOM.gameStatsBar.classList.add('hidden');
      DOM.hudBottom.classList.add('hidden');
      DOM.crosshair.classList.add('hidden');
      DOM.waveBanner.classList.add('hidden');
      if (DOM.btnExitGame) DOM.btnExitGame.classList.add('hidden');
      if (DOM.bottomDock) DOM.bottomDock.classList.add('hidden');
      this.clearRadar();

      DOM.finalLevel.textContent = `LIVELLO ${GAME_STATE.level}`;
      DOM.finalScore.textContent = GAME_STATE.score;
      DOM.finalDucks.textContent = GAME_STATE.ducksHit;
      DOM.finalDamage.textContent = `${GAME_STATE.totalDamageTaken} HP`;

      if (isDefeat) {
        DOM.gameOverTitle.textContent = `SEI STATO SOPRAFFATTO AL LIVELLO ${GAME_STATE.level}!`;
        DOM.gameOverSubtitle.textContent = `Le paperelle armate hanno travolto le tue difese!`;
        DOM.gameOverBadge.textContent = '💀';
      } else {
        DOM.gameOverTitle.textContent = `VITTORIA LEGGENDARIA!`;
        DOM.gameOverSubtitle.textContent = `Hai superato tutte le ondate di paperelle armate!`;
        DOM.gameOverBadge.textContent = '🏆';
      }

      // Reset & preparazione box salvataggio record Arcade
      this.hasSavedScoreThisRound = false;
      if (DOM.arcadeRegisterBox) {
        DOM.arcadeRegisterBox.classList.remove('hidden');
      }
      if (DOM.arcadeSaveFeedback) {
        DOM.arcadeSaveFeedback.classList.add('hidden');
        DOM.arcadeSaveFeedback.textContent = '';
      }
      if (DOM.btnSaveScore) {
        DOM.btnSaveScore.disabled = false;
        DOM.btnSaveScore.innerHTML = '<span class="save-icon">💾</span><span class="save-text">SALVA</span>';
      }
      if (DOM.arcadeInputName) {
        try {
          const lastName = localStorage.getItem('duckhunt_last_player_name') || 'CARM';
          DOM.arcadeInputName.value = lastName;
        } catch (e) {
          DOM.arcadeInputName.value = 'CARM';
        }
      }

      // Schermata protetta da tap accidentali per i primi 1200ms
      this.isDefeatTapShieldActive = true;
      DOM.gameOverOverlay.classList.add('tap-shield');
      DOM.gameOverOverlay.classList.remove('hidden');

      setTimeout(() => {
        this.isDefeatTapShieldActive = false;
        if (DOM.gameOverOverlay) {
          DOM.gameOverOverlay.classList.remove('tap-shield');
        }
      }, 1200);
      audio.vibrate([100, 60, 140]);
    }

    openLeaderboard(highlightId = null) {
      if (DOM.bottomDock) DOM.bottomDock.classList.add('hidden');
      if (this.leaderboardMgr && DOM.leaderboardTableBody) {
        this.leaderboardMgr.render(DOM.leaderboardTableBody, highlightId);
      }
      if (DOM.leaderboardOverlay) {
        DOM.leaderboardOverlay.classList.remove('hidden');
      }
    }

    saveCurrentPlayerScore() {
      if (this.hasSavedScoreThisRound) {
        this.openLeaderboard(this.leaderboardMgr.lastSavedId);
        return;
      }

      const rawName = DOM.arcadeInputName ? DOM.arcadeInputName.value : '';
      const cleanName = (rawName || 'CARM').trim().toUpperCase().slice(0, 5) || 'CARM';

      const result = this.leaderboardMgr.addScore(
        cleanName,
        GAME_STATE.score,
        GAME_STATE.level,
        GAME_STATE.ducksHit
      );
      this.hasSavedScoreThisRound = true;

      audio.init();
      audio.playHighscoreFanfare();

      if (DOM.arcadeSaveFeedback) {
        DOM.arcadeSaveFeedback.classList.remove('hidden');
        if (result.rank) {
          DOM.arcadeSaveFeedback.innerHTML = `🎉 <strong>TOP 10 (#${result.rank})!</strong> Record registrato in classifica!`;
        } else {
          DOM.arcadeSaveFeedback.innerHTML = `✅ Punteggio di <strong>${cleanName}</strong> registrato con successo!`;
        }
      }

      if (DOM.btnSaveScore) {
        DOM.btnSaveScore.innerHTML = '<span class="save-icon">✓</span><span class="save-text">SALVATO</span>';
      }

      setTimeout(() => {
        this.openLeaderboard(result.entry.id);
      }, 450);
    }

    // =========================================================================
    // MODALITÀ 3D CONTATTI: PAPERELLE POSTINE SOCIAL (INSTAGRAM & TIKTOK)
    // =========================================================================
    async startContactsExperience(gyroPermissionPromise) {
      DOM.startOverlay.classList.add('hidden');
      if (DOM.contactsHud) DOM.contactsHud.classList.remove('hidden');
      if (DOM.bottomDock) DOM.bottomDock.classList.add('hidden');

      if (gyroPermissionPromise) {
        try {
          const permResult = await gyroPermissionPromise;
          if (permResult === 'granted') {
            this.listenToDeviceOrientation();
          } else {
            this.enableFallbackDragControls();
          }
        } catch (err) {
          this.enableFallbackDragControls();
        }
      } else {
        this.listenToDeviceOrientation();
      }

      await this.initCameraPassThrough();
      this.setup3DScene();

      // Nascondi fucile da caccia e HUD di combattimento
      if (this.fpsGun && this.fpsGun.gun) this.fpsGun.gun.visible = false;
      DOM.gameStatsBar.classList.add('hidden');
      DOM.hudBottom.classList.add('hidden');
      DOM.crosshair.classList.add('hidden');
      DOM.waveBanner.classList.add('hidden');
      if (DOM.btnExitGame) DOM.btnExitGame.classList.add('hidden');
      if (DOM.bottomDock) DOM.bottomDock.classList.add('hidden');
      this.clearRadar();

      GAME_STATE.isContactsMode = true;
      GAME_STATE.isPlaying = false;

      this.clearSocialDeliveryDucks();

      // Delay di 1 secondo prima della comparsa delle 2 paperelle 3D
      if (this.contactsSpawnTimeout) clearTimeout(this.contactsSpawnTimeout);
      this.contactsSpawnTimeout = setTimeout(() => {
        if (GAME_STATE.isContactsMode) {
          this.spawnSocialDeliveryDucks();
        }
      }, 1000);
    }

    spawnSocialDeliveryDucks() {
      this.clearSocialDeliveryDucks();
      const THREE = this.THREE;

      // 1. Paperella Instagram (a sinistra, side = -1)
      const instaDuck = createDeliveryDuck3D(THREE, 'instagram');
      instaDuck.side = -1;
      this.scene.add(instaDuck.group);
      this.contactsDucks.push(instaDuck);

      // 2. Paperella TikTok (a destra, side = 1)
      const tiktokDuck = createDeliveryDuck3D(THREE, 'tiktok');
      tiktokDuck.side = 1;
      this.scene.add(tiktokDuck.group);
      this.contactsDucks.push(tiktokDuck);

      // Posiziona immediatamente le paperelle in partenza ESATTAMENTE di fronte alla visuale corrente della fotocamera
      const camPos = this.camera.position;
      const forward = new THREE.Vector3(0, 0, -1).applyQuaternion(this.camera.quaternion).normalize();
      const right = new THREE.Vector3(1, 0, 0).applyQuaternion(this.camera.quaternion).normalize();
      const up = new THREE.Vector3(0, 1, 0).applyQuaternion(this.camera.quaternion).normalize();

      this.contactsDucks.forEach(d => {
        d.group.position.copy(camPos)
          .addScaledVector(forward, 7.2)
          .addScaledVector(right, d.side * 2.0)
          .addScaledVector(up, 0.35);
        d.group.lookAt(camPos);
      });

      audio.playArcadeCoin();
      audio.vibrate([40, 30, 50]);
    }

    clearSocialDeliveryDucks() {
      if (this.contactsSpawnTimeout) {
        clearTimeout(this.contactsSpawnTimeout);
        this.contactsSpawnTimeout = null;
      }
      if (DOM.boxButtonInstagram) DOM.boxButtonInstagram.classList.add('hidden');
      if (DOM.boxButtonTiktok) DOM.boxButtonTiktok.classList.add('hidden');

      if (this.contactsDucks && this.contactsDucks.length > 0) {
        this.contactsDucks.forEach(d => {
          if (d.group && d.group.parent) d.group.parent.remove(d.group);
        });
        this.contactsDucks = [];
      }
    }

    closeContactsExperience() {
      this.clearSocialDeliveryDucks();
      if (DOM.contactsHud) DOM.contactsHud.classList.add('hidden');
      DOM.startOverlay.classList.remove('hidden');
      if (DOM.bottomDock) DOM.bottomDock.classList.remove('hidden');

      if (this.fpsGun && this.fpsGun.gun) this.fpsGun.gun.visible = true;
      GAME_STATE.isContactsMode = false;
      this.isGameManualPaused = false;
      this.updateDockGameButton('🎮', 'Gioca');
    }

    updateSocialDeliveryDucks(dt) {
      if (!this.contactsDucks || this.contactsDucks.length === 0) return;
      const time = performance.now() * 0.001;
      const THREE = this.THREE;

      // Calcola in tempo reale i vettori di vista attuali della camera per garantire
      // che le paperelle rimangano sempre di fronte all'inquadratura dell'utente
      const camPos = this.camera.position;
      const forward = new THREE.Vector3(0, 0, -1).applyQuaternion(this.camera.quaternion).normalize();
      const right = new THREE.Vector3(1, 0, 0).applyQuaternion(this.camera.quaternion).normalize();
      const up = new THREE.Vector3(0, 1, 0).applyQuaternion(this.camera.quaternion).normalize();

      for (let i = 0; i < this.contactsDucks.length; i++) {
        const d = this.contactsDucks[i];

        // 1. Volo in avvicinamento da 7.2m fino a 3.3m davanti alla camera (più distanti e ben inquadrate su mobile)
        d.progress = Math.min(1, d.progress + dt * 0.95);
        const t = d.progress;
        const ease = t * (2 - t); // ease-out

        const curDist = THREE.MathUtils.lerp(7.2, 3.3, ease);
        const curLat = THREE.MathUtils.lerp(2.0, 0.84, ease) * d.side;
        const curVert = THREE.MathUtils.lerp(0.35, -0.05, ease);

        _v1.copy(camPos)
          .addScaledVector(forward, curDist)
          .addScaledVector(right, curLat)
          .addScaledVector(up, curVert);

        // Fluttuazione morbida di volo
        _v1.y += Math.sin(time * 2.8 + d.phase) * 0.06;
        _v1.x += Math.cos(time * 1.8 + d.phase) * 0.03;

        if (d.isHappy) {
          d.happyTimer += dt;
          d.duckMesh.rotation.y += dt * 14;
          _v1.y += Math.sin(d.happyTimer * 12) * 0.22;
          if (d.happyTimer > 1.2) {
            d.isHappy = false;
            d.duckMesh.rotation.y = 0;
          }
        } else {
          d.group.lookAt(camPos);
        }

        d.group.position.lerp(_v1, Math.min(1, dt * 7.5));

        // Battito d'ali
        if (d.duckMesh && d.duckMesh.userData) {
          const flap = Math.sin(time * 14 + d.phase) * 0.42;
          if (d.duckMesh.userData.leftWing) d.duckMesh.userData.leftWing.rotation.z = flap;
          if (d.duckMesh.userData.rightWing) d.duckMesh.userData.rightWing.rotation.z = -flap;
        }

        // Oscillazione pendolare della scatola
        if (d.pkgGroup) {
          d.pkgGroup.rotation.z = Math.sin(time * 2.2 + d.phase) * 0.08;
          d.pkgGroup.rotation.x = Math.cos(time * 2.0 + d.phase) * 0.06;
        }

        // 2. APERTURA SCATOLA & COMPARSA DEI PULSANTI DALLE SCATOLE
        if (d.progress >= 0.85) {
          d.boxOpenProgress = Math.min(1, d.boxOpenProgress + dt * 2.4);

          // Coperchio 3D che si apre ruotando all'indietro
          if (d.lidPivot) {
            d.lidPivot.rotation.x = -Math.PI * 0.55 * d.boxOpenProgress;
          }

          // Scheda/pedestallo 3D che sale dall'interno della scatola
          if (d.popCardGroup) {
            d.popCardGroup.position.y = THREE.MathUtils.lerp(-0.06, 0.40, d.boxOpenProgress);
            d.popCardGroup.scale.setScalar(Math.min(1, d.boxOpenProgress * 1.05));
          }

          // Proiezione del pulsante interattivo a schermo ancorato alla scatola
          const domBtn = (d.brand === 'instagram') ? DOM.boxButtonInstagram : DOM.boxButtonTiktok;
          if (domBtn && d.anchorPoint) {
            _v2.setFromMatrixPosition(d.anchorPoint.matrixWorld);
            _v2.project(this.camera);

            if (_v2.z < 1) {
              const screenX = (_v2.x * 0.5 + 0.5) * window.innerWidth;
              const screenY = (-(_v2.y * 0.5) + 0.5) * window.innerHeight;

              // Rimbalzo elastico di uscita dalla scatola
              const spring = Math.min(1, d.boxOpenProgress * (1 + Math.sin(d.boxOpenProgress * Math.PI) * 0.22));
              domBtn.style.transform = `translate(${screenX}px, ${screenY}px) translate(-50%, -100%) scale(${spring})`;
              domBtn.classList.remove('hidden');
            }
          }
        }
      }
    }

    checkSocialDuckClick(e) {
      if (!this.contactsDucks || this.contactsDucks.length === 0) return;
      const mouse = new this.THREE.Vector2(
        (e.clientX / window.innerWidth) * 2 - 1,
        -(e.clientY / window.innerHeight) * 2 + 1
      );
      this.raycaster.setFromCamera(mouse, this.camera);
      const colliders = this.contactsDucks.map(d => d.colliderMesh);
      const intersects = this.raycaster.intersectObjects(colliders, false);
      if (intersects.length > 0) {
        const hit = intersects[0].object;
        const duckData = this.contactsDucks.find(d => d.colliderMesh === hit);
        if (duckData) {
          this.onSocialDuckTapped(duckData);
        }
      }
    }

    onSocialDuckTapped(duckData) {
      audio.init();
      audio.playArcadeCoin();
      audio.vibrate([50, 40, 70]);

      if (this.particles) {
        const pColor = (duckData.brand === 'instagram') ? 0xE1306C : 0x00F2FE;
        this.particles.burst(duckData.group.position, pColor, 35);
      }

      duckData.isHappy = true;
      duckData.happyTimer = 0;

      setTimeout(() => {
        window.open(duckData.url, '_blank', 'noopener,noreferrer');
      }, 220);
    }

    /**
     * Loop principale a 60 FPS con Camera Shake e IA FSM
     */
    gameLoop(dt) {
      const THREE = this.THREE;

      // 1. Orientamento visuale 360°
      if (GAME_STATE.hasGyro && GAME_STATE.gyroActive) {
        const alpha = THREE.MathUtils.degToRad(GAME_STATE.gyroAlpha);
        const beta = THREE.MathUtils.degToRad(GAME_STATE.gyroBeta);
        const gamma = THREE.MathUtils.degToRad(GAME_STATE.gyroGamma);
        const orient = THREE.MathUtils.degToRad(GAME_STATE.screenOrientation);

        this.cameraEuler.set(beta, alpha, -gamma, 'YXZ');
        this.deviceQuaternion.setFromEuler(this.cameraEuler);
        this.deviceQuaternion.multiply(this.q1);
        this.deviceQuaternion.multiply(this.q0.setFromAxisAngle(this.zee, -orient));

        _v1.set(0, 1, 0);
        this.recenterQuaternion.setFromAxisAngle(_v1, this.yawOffset);
        this.camera.quaternion.copy(this.recenterQuaternion).multiply(this.deviceQuaternion);
      } else {
        this.camera.rotation.set(this.manualPitch, this.manualYaw, 0, 'YXZ');
      }

      // Se siamo in modalità Contatti 3D: aggiorna le paperelle postine e renderizza
      if (GAME_STATE.isContactsMode) {
        this.updateSocialDeliveryDucks(dt);
        if (this.particles) this.particles.update(dt);
        this.renderer.render(this.scene, this.camera);
        return;
      }

      // Camera Shake Three.js su ricezione danno o impatto colpo a segno (offset posizione e micro-rotazione)
      if (this.cameraShakeIntensity > 0.001) {
        const sx = (Math.random() - 0.5) * this.cameraShakeIntensity;
        const sy = (Math.random() - 0.5) * this.cameraShakeIntensity;
        const sz = (Math.random() - 0.5) * (this.cameraShakeIntensity * 0.5);
        this.camera.position.set(sx, sy, sz);

        const rotShake = this.cameraShakeIntensity * 0.16;
        this.camera.rotation.z += (Math.random() - 0.5) * rotShake;

        this.cameraShakeIntensity = THREE.MathUtils.lerp(this.cameraShakeIntensity, 0, dt * 14);
      } else {
        this.camera.position.set(0, 0, 0);
      }

      // 2. Weapon Sway Inerziale & Idle Bobbing del Fucile FPV
      if (this.fpsGun) {
        _euler.setFromQuaternion(this.camera.quaternion, 'YXZ');
        const dYaw = _euler.y - this.lastCameraEuler.y;
        const dPitch = _euler.x - this.lastCameraEuler.x;
        this.lastCameraEuler.copy(_euler);

        const clampedDYaw = Math.max(-0.25, Math.min(0.25, dYaw));
        const clampedDPitch = Math.max(-0.25, Math.min(0.25, dPitch));

        const targetSwayX = -clampedDYaw * 0.12;
        const targetSwayY = -clampedDPitch * 0.12;

        this.fpsGun.swayX = THREE.MathUtils.lerp(this.fpsGun.swayX, targetSwayX, dt * 10);
        this.fpsGun.swayY = THREE.MathUtils.lerp(this.fpsGun.swayY, targetSwayY, dt * 10);

        this.fpsGun.recoilZ = THREE.MathUtils.lerp(this.fpsGun.recoilZ, 0, dt * 14);
        this.fpsGun.recoilRotX = THREE.MathUtils.lerp(this.fpsGun.recoilRotX, 0, dt * 14);
        this.fpsGun.muzzleLight.intensity = THREE.MathUtils.lerp(this.fpsGun.muzzleLight.intensity, 0, dt * 16);
        if (this.fpsGun.muzzleLight.intensity < 0.05) this.fpsGun.muzzleLight.intensity = 0;

        const time = performance.now() * 0.002;
        const bobX = Math.sin(time) * 0.0035;
        const bobY = Math.cos(time * 2.0) * 0.0025;

        this.fpsGun.gun.position.set(
          this.fpsGun.basePos.x + this.fpsGun.swayX + bobX,
          this.fpsGun.basePos.y + this.fpsGun.swayY + bobY,
          this.fpsGun.basePos.z + this.fpsGun.recoilZ
        );
        this.fpsGun.gun.rotation.set(
          this.fpsGun.baseRot.x + this.fpsGun.recoilRotX + this.fpsGun.swayY * 0.5,
          this.fpsGun.baseRot.y + this.fpsGun.swayX * 0.6,
          this.fpsGun.baseRot.z
        );
      }

      // 3. Aggiornamento particelle, fumo, popups 3D e proiettili nemici
      if (this.particles) this.particles.update(dt);
      if (this.smokeSystem) this.smokeSystem.update(dt);
      if (this.scorePopups3D) this.scorePopups3D.update(dt);

      if (this.projectilesMgr && GAME_STATE.isPlaying) {
        this.projectilesMgr.update(
          dt,
          this.camera.position,
          (dmg, type) => this.takeDamage(dmg, type),
          this.smokeSystem
        );
      }

      // 4. Timer Combo
      if (GAME_STATE.isPlaying && GAME_STATE.combo > 1) {
        GAME_STATE.comboTimer -= dt;
        if (GAME_STATE.comboTimer <= 0) {
          GAME_STATE.combo = 1;
          this.updateHUDStats();
        }
      }

      // 5. IA Paperelle & Macchina a Stati Finiti (FSM)
      for (let i = this.ducks.length - 1; i >= 0; i--) {
        const duck = this.ducks[i];
        if (!duck.alive) {
          this.ducks.splice(i, 1);
          continue;
        }

        // --- STATO PERCH (Appollaiata su oggetto reale) ---
        if (duck.state === 'PERCH') {
          duck.mesh.position.lerp(duck.perchTarget, dt * 2.6);
          duck.mesh.userData.flapSpeed = 6.0;

          const perchBob = Math.sin(performance.now() * 0.0035 + duck.theta) * 0.015;
          duck.mesh.position.y += perchBob;
          duck.mesh.lookAt(this.camera.position.x, duck.mesh.position.y, this.camera.position.z);

          duck.perchTimer -= dt;
          if (duck.perchTimer <= 0) {
            duck.state = 'PATROL';
            duck.isPerchedBonus = false;
            duck.mesh.userData.flapSpeed = 24.0;
          }
        }
        // --- STATO ATTACK_APPROACH (Carica verso il giocatore / Zigzag) ---
        else if (duck.state === 'ATTACK_APPROACH') {
          const toCamera = _v1.subVectors(this.camera.position, duck.mesh.position);
          const dist = toCamera.length();
          toCamera.normalize();

          if (duck.attackType === 'knife_zigzag') {
            duck.zigzagPhase += dt * 10.0;
            _v2.crossVectors(toCamera, new THREE.Vector3(0, 1, 0)).normalize();
            const zigzagOffset = Math.sin(duck.zigzagPhase) * 0.55;
            duck.mesh.position.addScaledVector(_v2, zigzagOffset * dt * 2.8);
          }

          duck.mesh.position.addScaledVector(toCamera, duck.attackSpeed * dt);
          duck.mesh.lookAt(this.camera.position);
          duck.mesh.userData.flapSpeed = 34.0;

          // Impatto sul giocatore (< 0.8 metri)
          if (dist < 0.8) {
            this.takeDamage(duck.damage, 'melee');
            // Reset in orbita
            duck.distance = 5.5 + Math.random() * 2.0;
            duck.theta = Math.random() * Math.PI * 2;
            duck.phi = (Math.random() - 0.5) * (Math.PI * 0.4);
            duck.state = 'PATROL';
            duck.attackCooldown = duck.attackCooldownMin + Math.random() * (duck.attackCooldownMax - duck.attackCooldownMin);
            duck.mesh.userData.flapSpeed = 24.0;
          }
        }
        // --- STATO FIRE_PREPARE (Mira e sparo proiettile) ---
        else if (duck.state === 'FIRE_PREPARE') {
          duck.mesh.lookAt(this.camera.position);
          duck.firePrepTimer -= dt;
          if (duck.firePrepTimer <= 0) {
            _v1.copy(duck.mesh.position);
            if (duck.attackType === 'shoot_bullet') {
              this.projectilesMgr.spawnBullet(_v1, this.camera.position);
            } else if (duck.attackType === 'shoot_rocket') {
              this.projectilesMgr.spawnRocket(_v1, this.camera.position);
            }
            duck.state = 'PATROL';
            duck.attackCooldown = duck.attackCooldownMin + Math.random() * (duck.attackCooldownMax - duck.attackCooldownMin);
          }
        }
        // --- STATO PATROL (Volo orbitale a 360°) ---
        else {
          duck.theta += duck.speedTheta * dt;
          duck.mesh.userData.wobblePhase += dt * 6.5;

          const r = duck.distance;
          const bob = Math.sin(duck.theta * duck.bobSpeed) * duck.bobHeight;

          duck.mesh.position.set(
            Math.cos(duck.phi) * Math.sin(duck.theta) * r,
            Math.sin(duck.phi) * r + bob,
            Math.cos(duck.phi) * Math.cos(duck.theta) * r
          );

          const tangentX = Math.cos(duck.phi) * Math.cos(duck.theta) * (duck.speedTheta > 0 ? 1 : -1);
          const tangentZ = -Math.cos(duck.phi) * Math.sin(duck.theta) * (duck.speedTheta > 0 ? 1 : -1);
          duck.mesh.lookAt(duck.mesh.position.x + tangentX, duck.mesh.position.y, duck.mesh.position.z + tangentZ);

          const rollWobble = Math.sin(duck.mesh.userData.wobblePhase) * 0.18;
          const pitchWobble = Math.cos(duck.mesh.userData.wobblePhase * 0.8) * 0.1;
          duck.mesh.rotation.z += rollWobble;
          duck.mesh.rotation.x += pitchWobble;

          // Gestione trigger attacco
          if (duck.canAttack && !this.isWaveTransitioning) {
            duck.attackCooldown -= dt;
            if (duck.attackCooldown <= 0) {
              if (duck.attackType === 'dive' || duck.attackType === 'knife_zigzag') {
                duck.state = 'ATTACK_APPROACH';
              } else if (duck.attackType === 'shoot_bullet' || duck.attackType === 'shoot_rocket') {
                duck.state = 'FIRE_PREPARE';
                duck.firePrepTimer = 0.65;
              }
            }
          }
        }

        if (duck.mesh.userData.tuftGroup) {
          duck.mesh.userData.tuftGroup.rotation.x = Math.sin(duck.mesh.userData.wobblePhase * 1.6) * 0.32;
        }

        if (duck.mesh.userData.leftFoot && duck.mesh.userData.rightFoot) {
          const kick = Math.sin(duck.mesh.userData.wobblePhase) * 0.35;
          duck.mesh.userData.leftFoot.rotation.x = kick;
          duck.mesh.userData.rightFoot.rotation.x = -kick;
        }

        duck.mesh.userData.wingPhase += dt * duck.mesh.userData.flapSpeed;
        const flap = Math.sin(duck.mesh.userData.wingPhase) * 0.65;
        if (duck.mesh.userData.leftWing && duck.mesh.userData.rightWing) {
          duck.mesh.userData.leftWing.rotation.z = flap;
          duck.mesh.userData.rightWing.rotation.z = -flap;
        }
      }

      // 6. Animazione paperelle abbattute (caduta gravitazionale rapida con scia di piume)
      for (let i = this.dyingDucks.length - 1; i >= 0; i--) {
        const d = this.dyingDucks[i];
        d.age += dt;
        d.velY -= (d.gravity || 16.0) * dt;
        d.mesh.position.y += d.velY * dt;

        d.mesh.rotation.x += d.rotVelX * dt;
        d.mesh.rotation.y += d.rotVelY * dt;
        d.mesh.rotation.z += d.rotVelZ * dt;

        // Scia periodica di piume durante la caduta
        d.featherTimer = (d.featherTimer || 0) + dt;
        if (d.featherTimer >= 0.12 && d.age < 0.5) {
          d.featherTimer = 0;
          if (this.particles && this.particles.burstFeathers) {
            this.particles.burstFeathers(d.mesh.position, 6, d.color);
          }
        }

        d.scale = Math.max(0, 1.0 - (d.age / 0.65));
        d.mesh.scale.set(d.scale, d.scale, d.scale);

        if (d.age >= 0.65) {
          if (d.mesh.parent) d.mesh.parent.remove(d.mesh);
          this.dyingDucks.splice(i, 1);
        }
      }

      // 7. Check Mirino con Target Lock ed etichetta minaccia
      if (this.camera && GAME_STATE.isPlaying) {
        this.raycaster.setFromCamera(_screenCenter, this.camera);
        const allTargets = [...this.hittableColliders, ...this.projectilesMgr.hittableColliders];
        const hits = this.raycaster.intersectObjects(allTargets, false);

        if (hits.length > 0) {
          DOM.crosshair.classList.add('locked');
          const hitObj = hits[0].object;

          if (hitObj.userData.projectileData) {
            const isRocket = (hitObj.userData.projectileData.type === 'rocket');
            DOM.crosshairLockLabel.textContent = isRocket ? "INTERCETTA RAZZO RPG!" : "INTERCETTA PROIETTILE!";
          } else if (hitObj.userData.duckData) {
            const duckData = hitObj.userData.duckData;
            if (duckData.state === 'PERCH') {
              const objName = duckData.targetObjectName || 'OGGETTO';
              DOM.crosshairLockLabel.textContent = `BERSAGLIO SU ${objName}! (2X)`;
            } else if (duckData.state === 'ATTACK_APPROACH') {
              DOM.crosshairLockLabel.textContent = "ATTENZIONE: IN ATTACCO!";
            } else {
              DOM.crosshairLockLabel.textContent = "PAPEROTTO A TIRO!";
            }
          }
        } else {
          DOM.crosshair.classList.remove('locked');
          DOM.crosshairLockLabel.textContent = "MIRINO DA CACCIA";
        }
      }

      // 8. Aggiornamento Radar / Sonar Circolare Tattico 360°
      if (GAME_STATE.isPlaying) {
        this.updateRadar(dt);
      }
    }

    clearRadar() {
      if (this.radarBlipPool) {
        for (let i = 0; i < this.radarBlipPool.length; i++) {
          this.radarBlipPool[i].style.display = 'none';
        }
      }
      if (DOM.radarContainer) {
        DOM.radarContainer.classList.add('hidden');
      }
    }

    /**
     * Aggiorna il Mini Radar / Sonar Circolare 360° in tempo reale:
     * calcola la proiezione orizzontale relativa all'orientamento del giocatore (Heading-Up)
     * e posiziona i blip con zero allocazioni GC a 60 FPS.
     */
    updateRadar(dt) {
      if (!GAME_STATE.isPlaying || !this.camera || !DOM.radarContainer || !DOM.radarBlips) {
        return;
      }

      // 1. Direzione di puntamento orizzontale della fotocamera
      _radarForward.set(0, 0, -1).applyQuaternion(this.camera.quaternion);
      const fwdLen = Math.hypot(_radarForward.x, _radarForward.z);
      const fx = fwdLen > 0.001 ? _radarForward.x / fwdLen : 0;
      const fz = fwdLen > 0.001 ? _radarForward.z / fwdLen : -1;

      // Vettore orizzontale a destra (+90° orario sul piano XZ)
      const rx = -fz;
      const rz = fx;

      const camPos = this.camera.position;
      const radarSize = DOM.radarContainer.offsetWidth || 90;
      const halfSize = radarSize * 0.5;
      const radarRadius = halfSize - 7; // margine per rimanere all'interno dell'anello esterno
      const maxRange = 8.5; // portata massima in metri

      if (!this.radarTargetsList) {
        this.radarTargetsList = [];
      }
      this.radarTargetsList.length = 0;

      // 2. Paperelle nemiche attive
      if (this.ducks) {
        for (let i = 0; i < this.ducks.length; i++) {
          const duck = this.ducks[i];
          if (!duck || !duck.alive || !duck.mesh) continue;

          const pos = duck.mesh.position;
          const dx = pos.x - camPos.x;
          const dy = pos.y - camPos.y;
          const dz = pos.z - camPos.z;

          // Coordinate proiettate su forward e right del giocatore
          const distForward = dx * fx + dz * fz;
          const distRight = dx * rx + dz * rz;
          const distHoriz = Math.hypot(distForward, distRight);

          // Angolo rispetto al centro di vista (0 = davanti a ore 12)
          const angle = Math.atan2(distRight, distForward);

          // Raggio scalato sul sonar
          const normDist = Math.min(1.0, distHoriz / maxRange);
          const rPx = Math.pow(normDist, 0.85) * radarRadius;

          const px = Math.round((halfSize + rPx * Math.sin(angle)) * 10) / 10;
          const py = Math.round((halfSize - rPx * Math.cos(angle)) * 10) / 10;

          let typeClass = 'blip-standard';
          if (duck.state === 'ATTACK_APPROACH' || duck.state === 'FIRE_PREPARE') {
            typeClass = 'blip-threat';
          } else if (duck.type === 'king') {
            typeClass = 'blip-gold';
          } else if (duck.state === 'PERCH') {
            typeClass = 'blip-perch';
          }

          let elevClass = '';
          if (dy > 1.2) elevClass = ' elev-above';
          else if (dy < -1.2) elevClass = ' elev-below';

          this.radarTargetsList.push({ px, py, typeClass, elevClass });
        }
      }

      // 3. Proiettili e Razzi nemici
      if (this.projectilesMgr && this.projectilesMgr.projectiles) {
        for (let j = 0; j < this.projectilesMgr.projectiles.length; j++) {
          const proj = this.projectilesMgr.projectiles[j];
          if (!proj || !proj.alive || !proj.mesh) continue;

          const pos = proj.mesh.position;
          const dx = pos.x - camPos.x;
          const dy = pos.y - camPos.y;
          const dz = pos.z - camPos.z;

          const distForward = dx * fx + dz * fz;
          const distRight = dx * rx + dz * rz;
          const distHoriz = Math.hypot(distForward, distRight);

          const angle = Math.atan2(distRight, distForward);
          const normDist = Math.min(1.0, distHoriz / maxRange);
          const rPx = Math.pow(normDist, 0.85) * radarRadius;

          const px = Math.round((halfSize + rPx * Math.sin(angle)) * 10) / 10;
          const py = Math.round((halfSize - rPx * Math.cos(angle)) * 10) / 10;

          const typeClass = (proj.type === 'rocket') ? 'blip-rocket' : 'blip-bullet';
          let elevClass = '';
          if (dy > 1.2) elevClass = ' elev-above';
          else if (dy < -1.2) elevClass = ' elev-below';

          this.radarTargetsList.push({ px, py, typeClass, elevClass });
        }
      }

      // 4. Aggiornamento pool elementi DOM
      if (!this.radarBlipPool) {
        this.radarBlipPool = [];
      }

      const count = this.radarTargetsList.length;
      for (let k = 0; k < count; k++) {
        const item = this.radarTargetsList[k];
        let blip = this.radarBlipPool[k];
        if (!blip) {
          blip = document.createElement('div');
          DOM.radarBlips.appendChild(blip);
          this.radarBlipPool.push(blip);
        }
        blip.style.display = 'block';
        blip.className = `radar-blip ${item.typeClass}${item.elevClass}`;
        blip.style.transform = `translate3d(${item.px}px, ${item.py}px, 0)`;
      }

      for (let k = count; k < this.radarBlipPool.length; k++) {
        this.radarBlipPool[k].style.display = 'none';
      }
    }
  }

  // =========================================================================
  // 11. AVVIO APPLICAZIONE
  // =========================================================================
  window.addEventListener('DOMContentLoaded', () => {
    const app = new DuckHunt360App();
    app.init();
  });

})();
