import { metaStore, fingerprintOf } from '../meta-store.mjs';

const log = (...a) => console.log('[t]', ...a);

const init = await metaStore.init();
log('init', JSON.stringify(init));

const item = { path: 'd:\\test\\a.mp3', size: 123, mtimeMs: 1000 };
await metaStore.putTracks([{
  fingerprint: fingerprintOf(item.path, item.size, Math.floor(item.mtimeMs)),
  path: item.path.toLowerCase(), size: item.size, mtime: 1,
  title: '测试曲', artist: '测试歌手', album: '测试专辑',
  lyrics: JSON.stringify({ source: 'online', lines: [{ time: 1, text: '嗨' }] }),
  lyricsFormat: 'json', provider: 'netease', confidence: 0.92,
}]);
log('putTracks done');

const got = await metaStore.getTrack(item.path, { size: item.size, mtimeMs: item.mtimeMs });
log('getTrack', got && got.title, got && got.provider);
log('stats', JSON.stringify(await metaStore.stats()));
log('putCover', JSON.stringify(await metaStore.putCover('abc123', Buffer.from('fakejpeg'), 'jpg', 'http://x')));
log('getCover', JSON.stringify(await metaStore.getCover('abc123')));
await metaStore.purge('all');
log('after purge', JSON.stringify(await metaStore.stats()));
metaStore.dispose();
setTimeout(() => process.exit(0), 500);
