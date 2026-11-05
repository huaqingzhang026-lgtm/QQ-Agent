// Pluto 大学生活模拟器：每周课表 + 每日生活 + 天气 + 突发事件。
// 用法：node tools/daily-life.mjs [--force] [--date=YYYY-MM-DD]
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { addEvent } from '../qq-bridge/src/memory-store.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const LIFE_DIR = path.join(ROOT, 'agent-home', 'life');
const WEEK_DIR = path.join(LIFE_DIR, 'week');
const DAY_DIR = path.join(LIFE_DIR, 'daily');
const LOG = path.join(ROOT, 'qq-bridge', 'state', 'daily-life.log');
const CITY = { name: '北京', lat: 39.9042, lon: 116.4074 };
const readJson = (f, d) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return d; } };
const writeJson = (f, v) => { fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, JSON.stringify(v, null, 2) + '\n', 'utf8'); };
const log = (m) => { const line = `[${new Date().toISOString()}] ${m}`; console.log(line); try { fs.appendFileSync(LOG, line + '\n', 'utf8'); } catch {} };
const ymd = (d = new Date()) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
const weekday = (d = new Date()) => ['周日', '周一', '周二', '周三', '周四', '周五', '周六'][d.getDay()];
function isoWeek(d = new Date()) {
  const t = new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()));
  const day = t.getUTCDay() || 7; t.setUTCDate(t.getUTCDate() + 4 - day);
  const y = new Date(Date.UTC(t.getUTCFullYear(), 0, 1));
  return `${t.getUTCFullYear()}-W${String(Math.ceil((((t - y) / 86400000) + 1) / 7)).padStart(2, '0')}`;
}

function cfg() { return readJson(path.join(ROOT, 'qq-bridge', 'config.json'), {}); }
function modelCfg() {
  const c = cfg(); const v = c.socialV2?.vision ?? {};
  const key = c.socialV2?.tts?.apiKey || v.apiKey || process.env.MIMO_API_KEY || '';
  return { key, base: String(v.baseUrl || 'https://api.xiaomimimo.com/v1').replace(/\/v1$/, '') + '/v1', model: v.model || 'mimo-v2.6-flash' };
}
async function askJson(prompt, max = 900) {
  const m = modelCfg(); if (!m.key) return null;
  try {
    const r = await fetch(m.base + '/chat/completions', { method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer ' + m.key }, body: JSON.stringify({ model: m.model, messages: [{ role: 'user', content: prompt }], max_completion_tokens: max, thinking: { type: 'disabled' } }), signal: AbortSignal.timeout(45000) });
    const j = await r.json().catch(() => null);
    const text = String(j?.choices?.[0]?.message?.content || '').trim();
    const a = text.indexOf('{'); const b = text.lastIndexOf('}');
    if (a < 0 || b <= a) return null;
    return JSON.parse(text.slice(a, b + 1));
  } catch { return null; }
}

const LIFE_STATE = path.join(ROOT, 'agent-home', 'life', 'state.json');
const STAGE = {
  enroll: '2026-09-01',
  birthday: '2008-03-14',
  major: '汉语言文学',
  university: '北京某大学',
  dorm: true
};
function parseDate(s) { const [y, m, d] = String(s).split('-').map(Number); return new Date(y, m - 1, d, 12); }
function lifeStage(date = new Date()) {
  const b = parseDate(STAGE.birthday);
  let age = date.getFullYear() - b.getFullYear();
  const beforeBirthday = date.getMonth() < b.getMonth() || (date.getMonth() === b.getMonth() && date.getDate() < b.getDate());
  if (beforeBirthday) age -= 1;
  const sep = new Date(date.getFullYear(), 8, 1, 12);
  const startYear = date >= sep ? date.getFullYear() : date.getFullYear() - 1;
  const gradeIndex = Math.max(0, startYear - 2026);
  const grade = Math.min(4, gradeIndex + 1);
  const labels = ['大一', '大二', '大三', '大四'];
  const month = date.getMonth() + 1;
  let semester = '第一学期';
  if (month >= 2 && month <= 6) semester = '第二学期';
  if (month === 7 || month === 8) semester = '暑假';
  if (month === 1) semester = '第一学期';
  const enroll = parseDate(STAGE.enroll);
  const days = Math.max(0, Math.floor((date - enroll) / 86400000));
  return { age, grade, gradeLabel: labels[grade - 1] || '毕业', semester, days, startYear, major: STAGE.major, university: STAGE.university, dorm: STAGE.dorm, birthday: STAGE.birthday, enroll: STAGE.enroll };
}
function updateLifeState(date = new Date(), daily = null) {
  const old = readJson(LIFE_STATE, { firstDay: ymd(date), days: 0, milestones: [], lastDaily: null });
  const stage = lifeStage(date);
  old.firstDay = old.firstDay || ymd(date);
  old.days = Math.max(Number(old.days || 0), stage.days);
  old.lastDaily = ymd(date);
  old.stage = stage;
  old.milestones = Array.isArray(old.milestones) ? old.milestones : [];
  const key = stage.gradeLabel + ':' + stage.semester;
  if (!old.milestones.includes(key)) { old.milestones.push(key); old.milestones = old.milestones.slice(-20); }
  if (daily) old.lastMood = daily.state?.mood || old.lastMood || '';
  writeJson(LIFE_STATE, old);
  return old;
}
export function growthBrief(date = new Date()) {
  const s = lifeStage(date);
  return '【成长阶段】' + s.gradeLabel + ' · ' + s.semester + ' · ' + s.age + ' 岁 · 大学生活第 ' + s.days + ' 天。专业：' + s.major + '；' + (s.dorm ? '住校宿舍。' : '走读。') + ' 年龄和年级随真实日期推进，不要永远停在 18 岁大一。\n\n';
}

async function weather() {
  try {
    const url = `https://api.open-meteo.com/v1/forecast?latitude=${CITY.lat}&longitude=${CITY.lon}&current=temperature_2m,weather_code,wind_speed_10m&daily=temperature_2m_max,temperature_2m_min,precipitation_probability_max&timezone=Asia%2FShanghai&forecast_days=1`;
    const j = await (await fetch(url, { signal: AbortSignal.timeout(12000) })).json();
    const code = Number(j?.current?.weather_code);
    const map = { 0: '晴', 1: '大部晴', 2: '多云', 3: '阴', 45: '雾', 48: '雾凇', 51: '小毛毛雨', 53: '毛毛雨', 55: '强毛毛雨', 61: '小雨', 63: '中雨', 65: '大雨', 71: '小雪', 73: '中雪', 75: '大雪', 80: '阵雨', 81: '强阵雨', 82: '暴雨', 95: '雷阵雨' };
    const text = map[code] || '多云';
    const lo = Math.round(Number(j?.daily?.temperature_2m_min?.[0]));
    const hi = Math.round(Number(j?.daily?.temperature_2m_max?.[0]));
    const rain = Number(j?.daily?.precipitation_probability_max?.[0]);
    return { city: CITY.name, text, temp: `${lo}~${hi}°C`, rain: Number.isFinite(rain) ? rain : null, wind: Number(j?.current?.wind_speed_10m) || null, source: 'open-meteo' };
  } catch { return { city: CITY.name, text: '多云', temp: '12~20°C', rain: null, source: 'fallback' }; }
}

const FALLBACK_WEEK = {
  '周一': [{ time: '08:00', name: '现代汉语', place: '教学楼 B203' }, { time: '14:00', name: '大学英语', place: '外语楼 301' }],
  '周二': [{ time: '10:00', name: '文学概论', place: '文科楼 105' }],
  '周三': [{ time: '08:00', name: '中国古代文学', place: '教学楼 A401' }, { time: '15:00', name: '体育', place: '体育馆' }],
  '周四': [{ time: '14:00', name: '基础写作', place: '文科楼 208' }],
  '周五': [{ time: '10:00', name: '现代汉语', place: '教学楼 B203' }],
  '周六': [], '周日': []
};

async function weeklyPlan(weekKey) {
  const stage = lifeStage();
  const file = path.join(WEEK_DIR, weekKey + '.json');
  const old = readJson(file, null);
  if (old?.days) return old;
  const prompt = `你是 Pluto 的大学课表生成器。她是北京某大学${stage.gradeLabel}汉语言文学专业女生，${stage.age}岁，住校。生成 ${weekKey} 这一周的课表，只输出 JSON：
{"week":"${weekKey}","days":{"周一":[{"time":"08:00","name":"课程","place":"教学楼"}],"周二":[],"周三":[],"周四":[],"周五":[],"周六":[],"周日":[]}}
要求：周一到周五每天 0-3 节，课程符合汉语言文学${stage.gradeLabel}；不要每天满课；周末一般没课；地点简短；只输出 JSON。`;
  const j = await askJson(prompt, 700);
  const data = { week: weekKey, grade: stage.gradeLabel, days: j?.days && typeof j.days === 'object' ? j.days : FALLBACK_WEEK, source: j?.days ? 'model' : 'fallback', generatedAt: Date.now() };
  writeJson(file, data);
  return data;
}

function clean(s, n = 200) { return String(s ?? '').replace(/\s+/g, ' ').trim().slice(0, n); }

async function dailyPlan(dateStr) {
  const d = new Date(dateStr + 'T12:00:00');
  const weekKey = isoWeek(d);
  const week = await weeklyPlan(weekKey);
  const wd = weekday(d);
  const courses = Array.isArray(week.days?.[wd]) ? week.days[wd] : [];
  const weatherNow = await weather();
  const stage = lifeStage(d);
  const yesterdayFile = path.join(DAY_DIR, ymd(new Date(d.getTime() - 86400000)) + '.json');
  const yesterday = readJson(yesterdayFile, null);
  const prompt = `你是 Pluto 的“大学生活模拟器”。Pluto 是 18 岁女生，北京某大学大一汉语言文学专业，住校宿舍。现在生成 ${dateStr}（${wd}）这一天，只输出 JSON。\n成长阶段：${stage.gradeLabel} · ${stage.semester} · ${stage.age} 岁 · 大学生活第 ${stage.days} 天\n天气：${weatherNow.city} ${weatherNow.text} ${weatherNow.temp}${weatherNow.rain != null ? '，降水概率 ' + weatherNow.rain + '%' : ''}\n今天课程：${JSON.stringify(courses)}\n昨天：${yesterday ? JSON.stringify({ routine: yesterday.routine, surprise: yesterday.surprise, mood: yesterday.state?.mood }).slice(0, 700) : '（无）'}\n格式：{"date":"${dateStr}","weather":{"city":"北京","text":"","temp":""},"state":{"mood":"","energy":0.6,"sleep":""},"courses":[],"routine":["3-6件具体日常"],"social":["1-2件社交"],"surprise":["0-2件小意外，可为空"],"topics":["2-4个可聊话题"]}\n要求：像真实大一女生的一天；有早八/食堂/宿舍/室友/作业/社团/北京天气细节；事件具体、口语化；不要狗血、重病、事故、违法、恋爱结婚、隐私；不要每天重复；不要写成日程表。`;
  const j = await askJson(prompt, 1100);
  const base = {
    date: dateStr, weekday: wd, weather: weatherNow, week: weekKey, growth: stage,
    state: { mood: '普通的一天', energy: 0.6, sleep: '还行' },
    courses: courses.map((c) => ({ time: clean(c.time, 8), name: clean(c.name, 30), place: clean(c.place, 30) })),
    routine: [], social: [], surprise: [], topics: [], source: 'fallback', generatedAt: Date.now(), city: CITY.name
  };
  if (j && typeof j === 'object') {
    if (j.state) base.state = { mood: clean(j.state.mood, 80) || base.state.mood, energy: Math.max(0, Math.min(1, Number(j.state.energy) || 0.6)), sleep: clean(j.state.sleep, 80) || base.state.sleep };
    if (Array.isArray(j.courses) && j.courses.length) base.courses = j.courses.slice(0, 5).map((c) => ({ time: clean(c.time, 8), name: clean(c.name, 30), place: clean(c.place, 30) }));
    for (const k of ['routine', 'social', 'surprise', 'topics']) if (Array.isArray(j[k])) base[k] = j[k].map((x) => clean(x, 160)).filter(Boolean).slice(0, k === 'routine' ? 6 : 4);
    if (j.weather) base.weather = { ...weatherNow, text: clean(j.weather.text, 40) || weatherNow.text, temp: clean(j.weather.temp, 30) || weatherNow.temp };
    base.source = 'model';
  }
  if (!base.routine.length) base.routine = ['早上被闹钟叫醒，赖了几分钟才起来', '中午和室友去食堂吃饭', '下午在宿舍写作业，中途刷了会儿手机', '晚上洗了澡，和室友聊了几句'];
  if (!base.social.length) base.social = ['室友问她要不要一起去拿快递'];
  if (!base.topics.length) base.topics = ['早八', '食堂', '作业', '北京天气'];
  base.growth = stage;
  const forbidden = /(重病|车祸|死亡|自杀|违法|赌博|欠债|家暴|结婚|怀孕)/;
  base.surprise = base.surprise.filter((x) => !forbidden.test(x));
  return base;
}

export function dailyLifeBrief(date = new Date()) {
  const file = path.join(DAY_DIR, ymd(date) + '.json');
  const d = readJson(file, null);
  if (!d) return '';
  const stage = d.growth || lifeStage();
  const lines = [
    `${stage.gradeLabel} · ${stage.semester} · ${stage.age} 岁 · 第 ${stage.days} 天`,
    `北京 ${d.weather?.text || ''} ${d.weather?.temp || ''}`.trim(),
    d.state?.mood ? `状态：${d.state.mood}` : '',
    d.courses?.length ? `课程：${d.courses.map((c) => c.name + (c.time ? ' ' + c.time : '')).join('、')}` : '今天没课',
    d.routine?.length ? `日常：${d.routine.slice(0, 4).join('；')}` : '',
    d.surprise?.length ? `小意外：${d.surprise.join('；')}` : '',
    d.topics?.length ? `可自然提起：${d.topics.join('、')}` : ''
  ].filter(Boolean);
  return lines.length ? `【今日生活】\n${lines.join('\n')}\n只在相关话题自然带出，不要主动播报整天安排。\n\n` : '';
}

export async function generateDailyLife(dateStr = ymd(), force = false) {
  const file = path.join(DAY_DIR, dateStr + '.json');
  if (!force && fs.existsSync(file)) return readJson(file, null);
  const data = await dailyPlan(dateStr);
  writeJson(file, data);
  updateLifeState(new Date(dateStr + 'T12:00:00'), data);
  // 写入统一时间线
  for (const text of [...data.routine, ...data.social, ...data.surprise]) {
    try { addEvent({ source: 'life', conversationKey: 'life:daily', actorId: 'pluto', actorName: 'Pluto', kind: 'daily-life', text, importance: 0.45, confidence: 0.75, sourceRef: `life:${dateStr}:${text.slice(0, 40)}` }); } catch {}
  }
  log(`已生成 ${dateStr}（${data.source}，日常 ${data.routine.length}，意外 ${data.surprise.length}）`);
  return data;
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  const dateArg = (process.argv.find((x) => x.startsWith('--date=')) || '').split('=')[1];
  const force = process.argv.includes('--force');
  generateDailyLife(dateArg || ymd(), force).then((d) => { if (!d) process.exit(1); process.exit(0); }).catch((e) => { log('生成失败：' + (e?.message ?? e)); process.exit(1); });
}
