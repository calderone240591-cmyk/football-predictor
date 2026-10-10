window.FP = window.FP || {};

// 25 чемпіонатів + 3 єврокубки. slug — ідентифікатор турніру в ESPN.
// q — орієнтовна сила ліги відносно найсильнішої (АПЛ = 1.00); потрібна, щоб у єврокубках
// порівнювати команди з різних чемпіонатів.
FP.LEAGUES = [
  { slug: 'uefa.champions',   name: 'Ліга чемпіонів',     short: 'ЛЧ',         country: 'УЄФА',       logo: 2,     cup: true },
  { slug: 'uefa.europa',      name: 'Ліга Європи',        short: 'ЛЄ',         country: 'УЄФА',       logo: 2310,  cup: true },
  { slug: 'uefa.europa.conf', name: 'Ліга конференцій',   short: 'ЛК',         country: 'УЄФА',       logo: 20296, cup: true },
  { slug: 'eng.1', name: 'Прем\'єр-ліга',  short: 'АПЛ',        country: 'Англія',     logo: 23, q: 1.00 },
  { slug: 'esp.1', name: 'Ла Ліга',        short: 'Ла Ліга',    country: 'Іспанія',    logo: 15, q: 0.97 },
  { slug: 'ita.1', name: 'Серія A',        short: 'Серія A',    country: 'Італія',     logo: 12, q: 0.95 },
  { slug: 'ger.1', name: 'Бундесліга',     short: 'Бундесліга', country: 'Німеччина',  logo: 10, q: 0.94 },
  { slug: 'fra.1', name: 'Ліга 1',         short: 'Ліга 1',     country: 'Франція',    logo: 9,  q: 0.90 },
  { slug: 'ned.1', name: 'Ередивізі',      short: 'Ередивізі',  country: 'Нідерланди', logo: 11, q: 0.85 },
  { slug: 'por.1', name: 'Прімейра Ліга',  short: 'Прімейра',   country: 'Португалія', logo: 14, q: 0.86 },
  { slug: 'bel.1', name: 'Про Ліга',       short: 'Бельгія',    country: 'Бельгія',    logo: 6,  q: 0.80 },
  { slug: 'tur.1', name: 'Суперліга',      short: 'Туреччина',  country: 'Туреччина',  logo: 18, q: 0.80 },
  { slug: 'eng.2', name: 'Чемпіоншип',     short: 'Чемпіоншип', country: 'Англія',     logo: 24, q: 0.76 },
  { slug: 'sco.1', name: 'Прем\'єршип',    short: 'Шотландія',  country: 'Шотландія',  logo: 45, q: 0.73 },
  { slug: 'aut.1', name: 'Бундесліга',     short: 'Австрія',    country: 'Австрія',    logo: 5,  q: 0.75 },
  { slug: 'gre.1', name: 'Суперліга',      short: 'Греція',     country: 'Греція',     logo: 98, q: 0.74 },
  { slug: 'den.1', name: 'Суперліга',      short: 'Данія',      country: 'Данія',      logo: null, q: 0.73 },
  { slug: 'bra.1', name: 'Серія A',        short: 'Бразилія',   country: 'Бразилія',   logo: 85, q: 0.86 },
  { slug: 'ger.2', name: '2. Бундесліга',  short: '2. Бундесл.', country: 'Німеччина', logo: 97,   q: 0.74 },
  { slug: 'esp.2', name: 'Сегунда',        short: 'Сегунда',    country: 'Іспанія',    logo: 107,  q: 0.72 },
  { slug: 'ita.2', name: 'Серія B',        short: 'Серія B',    country: 'Італія',     logo: 99,   q: 0.70 },
  { slug: 'fra.2', name: 'Ліга 2',         short: 'Ліга 2',     country: 'Франція',    logo: 96,   q: 0.70 },
  { slug: 'nor.1', name: 'Елітесеріен',    short: 'Норвегія',   country: 'Норвегія',   logo: null, q: 0.70 },
  { slug: 'swe.1', name: 'Аллсвенскан',    short: 'Швеція',     country: 'Швеція',     logo: 16,   q: 0.69 },
  { slug: 'usa.1', name: 'MLS',            short: 'MLS',        country: 'США',        logo: 19,   q: 0.74 },
  { slug: 'arg.1', name: 'Ліга Професьйональ', short: 'Аргентина', country: 'Аргентина', logo: 1, q: 0.78 },
  { slug: 'mex.1', name: 'Ліга MX',        short: 'Мексика',    country: 'Мексика',    logo: 22,   q: 0.74 },
  { slug: 'ksa.1', name: 'Про Ліга',       short: 'Саудівська А.', country: 'Саудівська Аравія', logo: 2488, q: 0.72 },
];

// Версія параметрів рекомендацій. Коли вона змінюється, статистика обнуляється і ведеться з нуля.
FP.STATS_VERSION = '2026-10-10-reset2';

FP.CUP_Q = 0.86;      // середній рівень учасника єврокубків
FP.UNKNOWN_Q = 0.68;   // команда з чемпіонату, якого немає в списку

FP.LEAGUE_BY_SLUG = new Map(FP.LEAGUES.map((l, i) => [l.slug, { ...l, order: i }]));

FP.leagueLogo = l => (l && l.logo
  ? `https://a.espncdn.com/i/leaguelogos/soccer/500/${l.logo}.png`
  : 'icons/icon.svg');

FP.pad = n => String(n).padStart(2, '0');

FP.localDate = offset => {
  const d = new Date();
  d.setDate(d.getDate() + offset);
  return `${d.getFullYear()}-${FP.pad(d.getMonth() + 1)}-${FP.pad(d.getDate())}`;
};

FP.dateOfTs = ts => {
  const d = new Date(ts * 1000);
  return `${d.getFullYear()}-${FP.pad(d.getMonth() + 1)}-${FP.pad(d.getDate())}`;
};
