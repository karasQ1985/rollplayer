/**
 * genre-normalize.mjs —— 流派值归一（分组干净的唯一入口）
 *
 * 为什么需要：本地内嵌标签是各家软件/个人手填的，同一个意思会出现
 *   Rock / rock / Hard Rock / Melodic Hard Rock / Alt. Rock / Punk Rock / Folk-Rock
 * 七种写法。不归一，前端按 genre 分组会裂成七个桶，"分组更干净"就落空。
 *
 * 策略：
 *   1. 白名单别名 → 标准大类（约 25 个桶），大小写与连字符差异一并吃掉
 *   2. 明显不是流派的脏值直接丢弃（纯数字、邮箱片段、"genre" 这类占位、非流派中文词）
 *   3. 白名单之外的词保留原名（只做大小写规范化），并标记 raw，便于事后人工收敛
 */

const ALIAS = new Map([
  /* --- Rock 家族：细分类收敛为一个桶 --- */
  ['rock', 'Rock'],
  ['hard rock', 'Rock'],
  ['melodic hard rock', 'Rock'],
  ['soft rock', 'Rock'],
  ['alt. rock', 'Rock'],
  ['alt rock', 'Rock'],
  ['alt-rock', 'Rock'],
  ['alternative rock', 'Rock'],
  ['alternative-rock', 'Rock'],
  ['punk rock', 'Rock'],
  ['punk', 'Rock'],
  ['folk-rock', 'Rock'],
  ['indie rock', 'Rock'],
  ['classic rock', 'Rock'],
  ['album rock', 'Rock'],
  ['general rock', 'Rock'],
  ['rock & roll', 'Rock'],
  ['rock and roll', 'Rock'],
  ['garage rock', 'Rock'],
  ['progressive rock', 'Rock'],
  ['psych rock', 'Rock'],

  /* --- Pop --- */
  ['pop', 'Pop'],
  ['dance pop', 'Pop'],
  ['teen pop', 'Pop'],
  ['synthpop', 'Pop'],
  ['popular music international pop', 'Pop'],
  ['easy listening', 'Pop'],

  /* --- Alternative / Indie --- */
  ['alternative', 'Alternative'],
  ['alternative & punk', 'Alternative'],
  ['alternative and punk', 'Alternative'],
  ['alternative/punk', 'Alternative'],
  ['general alternative', 'Alternative'],
  ['abstract', 'Alternative'],
  ['indie', 'Indie'],
  ['indie pop', 'Indie'],

  /* --- Metal --- */
  ['metal', 'Metal'],
  ['heavy metal', 'Metal'],
  ['melodic metal', 'Metal'],
  ['death metal', 'Metal'],
  ['black metal', 'Metal'],

  /* --- Hip-Hop / Rap --- */
  ['hip-hop', 'Hip-Hop'],
  ['hip hop', 'Hip-Hop'],
  ['rap', 'Hip-Hop'],
  ['rap & hip-hop', 'Hip-Hop'],
  ['rap and hip-hop', 'Hip-Hop'],
  ['hip-hop/rap', 'Hip-Hop'],
  ['hip hop/rap', 'Hip-Hop'],
  ['hip-hop/r&b', 'Hip-Hop'],

  /* --- R&B / Soul --- */
  ['r&b', 'R&B'],
  ['r&b/soul', 'R&B'],
  ['rnb', 'R&B'],
  ['soul', 'R&B'],

  /* --- 电子 --- */
  ['dance', 'Electronic'],
  ['dance & dj', 'Electronic'],
  ['dance & dj/house', 'Electronic'],
  ['electronica', 'Electronic'],
  ['electronic', 'Electronic'],
  ['trance', 'Electronic'],
  ['house', 'Electronic'],
  ['techno', 'Electronic'],
  ['edm', 'Electronic'],
  ['trip-hop', 'Electronic'],
  ['ambient', 'Ambient'],

  /* --- 地区/语种 --- */
  ['j-pop', 'J-Pop'],
  ['jpop', 'J-Pop'],
  ['j pop', 'J-Pop'],
  ['k-pop', 'K-Pop'],
  ['kpop', 'K-Pop'],
  ['mandopop', 'Mandopop'],
  ['cantopop/hk-pop', 'Cantopop'],
  ['cantopop', 'Cantopop'],
  ['cantonese pop', 'Cantopop'],

  /* --- 其它标准大类 --- */
  ['anime', 'Anime'],
  ['soundtrack', 'Soundtrack'],
  ['score', 'Soundtrack'],
  ['new age', 'New Age'],
  ['vocal', 'Vocal'],
  ['instrumental', 'Instrumental'],
  ['country', 'Country'],
  ['latin', 'Latin'],
  ['blues', 'Blues'],
  ['jazz', 'Jazz'],
  ['classical', 'Classical'],
  ['folk', 'Folk'],
  ['world', 'World'],
  ['religious', 'Religious'],
  ['spoken word', 'Spoken Word'],
  ['comedy', 'Comedy'],

  /* --- 中文标签 --- */
  ['流行', 'Pop'],
  ['摇滚', 'Rock'],
  ['民谣', 'Folk'],
  ['说唱', 'Hip-Hop'],
  ['电子', 'Electronic'],
  ['爵士', 'Jazz'],
  ['古典', 'Classical'],
  ['蓝调', 'Blues'],
  ['乡村', 'Country'],
  ['金属', 'Metal'],
  ['朋克', 'Rock'],
  ['原声', 'Soundtrack'],
  ['配乐', 'Soundtrack'],
  ['轻音乐', 'New Age'],
  ['动漫', 'Anime'],
]);

/** 明确不是流派的值 */
const JUNK_WORDS = new Set([
  'other', 'unknown', 'miscellaneous', 'uncategorized', 'none', 'null', 'n/a', 'na',
  'genre', 'unknown genre', 'unspecified', '未分类', '未知', '其他', '不详',
]);

/** 已知的中文流派词（含在中文里出现才允许通过） */
const ZH_KNOWN = new Set(['流行', '摇滚', '民谣', '说唱', '电子', '爵士', '古典', '蓝调', '乡村', '金属', '朋克', '原声', '配乐', '轻音乐', '动漫']);

/** 词首字母大写，保留 & / . 之类符号的常见写法 */
function titleCase(s) {
  return String(s)
    .split(' ')
    .filter(Boolean)
    .map((w) => (/^[a-z]/.test(w) ? w[0].toUpperCase() + w.slice(1) : w))
    .join(' ');
}

/**
 * @returns {{ name: string|null, junk?: string, raw?: boolean }}
 *   name 为 null 表示这条值不可用（junk 里给原因）
 *   raw=true 表示不在白名单里、按原样保留（只规范了大小写）
 */
export function normalizeGenre(input) {
  const rawText = String(input == null ? '' : input).trim().replace(/^["'“”]+|["'“”]+$/g, '');
  if (!rawText) return { name: null, junk: 'empty' };

  const lower = rawText.toLowerCase().replace(/\s+/g, ' ').trim();

  if (JUNK_WORDS.has(lower)) return { name: null, junk: 'placeholder' };
  if (/^\d+$/u.test(rawText)) return { name: null, junk: 'numeric' };
  if (rawText.includes('@')) return { name: null, junk: 'email-like' };
  if (rawText.length > 48) return { name: null, junk: 'too-long' };
  // 纯符号/乱码
  if (!/[a-z0-9\u4e00-\u9fa5]/iu.test(rawText)) return { name: null, junk: 'symbols' };

  const alias = ALIAS.get(lower);
  if (alias) return { name: alias };

  // 中文值：不是已知流派词的中文，一律视为填错（例如角色名、备注）
  if (/[\u4e00-\u9fa5]/u.test(rawText)) {
    const hit = [...ZH_KNOWN].find((z) => rawText.includes(z));
    if (hit) return { name: ALIAS.get(hit) };
    return { name: null, junk: 'zh-unrecognized' };
  }

  // 白名单外：保留原名（大小写规范化），标记 raw 供事后收敛
  return { name: titleCase(rawText), raw: true };
}

/** 批量归一，返回去重后的名字列表（过滤掉不可用值） */
export function normalizeGenreList(list) {
  const out = [];
  for (const item of list || []) {
    const r = normalizeGenre(item);
    if (r.name && !out.includes(r.name)) out.push(r.name);
  }
  return out;
}
