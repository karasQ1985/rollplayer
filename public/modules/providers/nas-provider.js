/**
 * 数据访问层：封装对本地代理服务(server.mjs)的全部 HTTP 调用。
 * 界面层只依赖本模块，不直接拼 fetch / URL。
 */

async function post(path, body) {
  const res = await fetch(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const t = await res.text().catch(() => '');
    throw new Error(`API ${path} 失败(${res.status}): ${t}`);
  }
  return res.json();
}

async function get(path) {
  const res = await fetch(path);
  if (!res.ok) {
    const t = await res.text().catch(() => '');
    throw new Error(`API ${path} 失败(${res.status}): ${t}`);
  }
  return res.json();
}

/** 校验目录是否存在且可读 */
export async function checkPath(p) {
  return post('/api/check', { path: p });
}

/** 清理服务端刮削缓存（歌词/封面/元数据内存缓存） */
export async function clearScrapeCache() {
  return post('/api/cache-clear', {});
}

/** 在资源管理器中定位文件所在目录并选中该文件 */
export async function revealInFolder(p) {
  return post('/api/open-dir', { path: p });
}

/** 打开路径：目录直接打开该文件夹，文件则定位并选中 */
export async function openPath(p) {
  return post('/api/open-path', { path: p });
}

/** 枚举本机盘符根（含网络驱动器映射盘符） */
export async function listDrives() {
  return get('/api/list');
}

/** 列出某目录下的子目录（供目录浏览弹窗） */
export async function listDir(path) {
  return get('/api/list?path=' + encodeURIComponent(path));
}

/** 创建后台扫描任务，返回 { requestId } */
export async function startScan(paths) {
  return post('/api/scan', { paths });
}

/** 轮询扫描进度 */
export async function scanStatus(requestId) {
  return get('/api/scan-status?requestId=' + encodeURIComponent(requestId));
}

/** 分批拉取去重后的音频清单 */
export async function fetchFiles(requestId, offset, limit) {
  return get(`/api/files?requestId=${encodeURIComponent(requestId)}&offset=${offset}&limit=${limit}`);
}

/** 批量校验路径存在性：返回 { existing, missing } */
export async function checkPaths(paths) {
  const r = await fetch('/api/check-paths', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ paths }),
  });
  if (!r.ok) return { existing: [], missing: paths };
  try {
    const d = await r.json();
    return { existing: d.existing || [], missing: d.missing || [] };
  } catch {
    return { existing: [], missing: paths };
  }
}

/** 构造某音频文件的流播放地址 */
export function streamUrl(filePath) {
  return '/stream?path=' + encodeURIComponent(filePath);
}

/** 构造某音频文件的内嵌封面地址（无封面时服务端返回 404） */
export function coverUrl(filePath) {
  return '/api/cover?path=' + encodeURIComponent(filePath);
}

/** 构造某音频文件的歌词地址（LRC 侧车 / 内嵌，无则 source=none） */
export function lyricsUrl(filePath) {
  return '/api/lyrics?path=' + encodeURIComponent(filePath);
}

/** 把路径字符串转成展示用的短名（去掉所在目录） */
export function baseName(p) {
  const parts = p.split(/[\\/]/);
  return parts[parts.length - 1] || p;
}
