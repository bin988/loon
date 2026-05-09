/*
 * XHS Like Saver - 小红书点赞自动保存
 *
 * 功能：点赞小红书笔记时自动保存图片/视频到手机相册
 * 平台：Loon 3.x (iOS 15+)
 *
 * 拦截处理三个 API 端点：
 *   /api/sns/v1/note/imagefeed    - 缓存图文笔记图片 URL
 *   /api/sns/v1/note/detailfeed/preload - 缓存视频笔记视频 URL
 *   /api/sns/v1/note/like          - 检测点赞，触发保存
 *
 * 使用方法：
 *   1. 在 Loon 中导入 XHSLikeSaver.plugin
 *   2. 确保已安装并信任 MITM 证书
 *   3. MITM hostname 只需 edith.xiaohongshu.com（不要加 CDN 域名）
 *   4. 浏览小红书时自动缓存，点赞时弹出通知
 *
 * 保存机制：
 *   点赞后通过 iOS 通知展示图片列表，所有原始图片链接自动复制到剪贴板，
 *   用户可粘贴到浏览器批量下载，或逐一点击保存。
 */

// ======================== 常量 ========================

var API_IMAGEFEED  = '/api/sns/v1/note/imagefeed';
var API_PRELOAD    = '/api/sns/v1/note/detailfeed/preload';
var API_LIKE       = '/api/sns/v1/note/like';

// ======================== 工具函数 ========================

function getUrlParam(url, key) {
  var regex = new RegExp('[?&]' + key + '=([^&#]+)');
  var match = url.match(regex);
  return match ? decodeURIComponent(match[1].replace(/\+/g, ' ')) : null;
}

function extractNoteIdFromBody(body) {
  // oid=discovery.NOTE_ID 或 oid=search.NOTE_ID 等
  var match = body ? body.match(/oid=[^.]*\.([^&\s]+)/) : null;
  if (match) return match[1];
  match = body ? body.match(/note_id=([^&\s]+)/) : null;
  return match ? match[1] : null;
}

function cacheKey(noteId) {
  return 'xhs_note_' + noteId;
}

function dlKey(noteId) {
  return 'xhs_dl_' + noteId;
}

function now() {
  var d = new Date();
  var h = d.getHours(); var m = d.getMinutes(); var s = d.getSeconds();
  return (h < 10 ? '0' : '') + h + ':' + (m < 10 ? '0' : '') + m + ':' + (s < 10 ? '0' : '') + s;
}

function log(msg) {
  console.log('[XHS ' + now() + '] ' + msg);
}

function clip(str, maxLen) {
  if (!str) return '';
  return str.length > maxLen ? str.substring(0, maxLen) + '…' : str;
}

function shortUrl(url, maxLen) {
  if (!url) return '';
  maxLen = maxLen || 55;
  // Remove protocol prefix for shorter display
  var s = url.replace(/^https?:\/\//, '');
  return s.length > maxLen ? s.substring(0, maxLen) + '…' : s;
}

// ======================== 缓存笔记数据 ========================

/**
 * 从 imagefeed 响应中缓存图文笔记的图片 URL
 */
function cacheImagefeed() {
  var noteId = getUrlParam($request.url, 'note_id');
  if (!noteId) { $done(); return; }

  try {
    var body = JSON.parse($response.body);
    var items = body.data;
    if (!items || !Array.isArray(items) || items.length === 0) { $done(); return; }

    var noteList = items[0].note_list;
    if (!noteList || noteList.length === 0) { $done(); return; }

    var note = noteList[0];
    var imagesList = note.images_list;
    if (!imagesList || imagesList.length === 0) { $done(); return; }

    // 提取所有图片尺寸的 URL
    var images = [];
    for (var i = 0; i < imagesList.length; i++) {
      var img = imagesList[i];
      images.push({
        url: img.url || null,
        original: img.original || null,
        large: img.url_size_large || img.url || null,
        fileid: img.fileid || null,
        width: img.width || 0,
        height: img.height || 0
      });
    }

    var authorName = '';
    if (items[0].user) {
      authorName = items[0].user.nickname || items[0].user.name || '';
    }

    var noteData = {
      type: 'normal',
      images: images,
      imageCount: images.length,
      desc: clip(note.desc || '', 100),
      author: authorName,
      cachedAt: Date.now()
    };

    $persistentStore.write(JSON.stringify(noteData), cacheKey(noteId));
    log('已缓存图文笔记 ' + noteId + ' (' + images.length + ' 张图)');
  } catch (e) {
    log('解析 imagefeed 失败: ' + e.message);
  }

  $done();
}

/**
 * 从 detailfeed/preload 响应中缓存视频笔记的视频 URL
 */
function cachePreload() {
  try {
    var body = JSON.parse($response.body);
    var preloadMap = body.data && body.data.preload_map;
    if (!preloadMap) { $done(); return; }

    for (var noteId in preloadMap) {
      if (!preloadMap.hasOwnProperty(noteId)) continue;
      var item = preloadMap[noteId];

      // 只处理视频类型笔记
      if (item.type !== 'video' || !item.video_info_v2) continue;

      var videoInfo = item.video_info_v2.media.video;
      var streams = videoInfo.stream;

      // 收集所有可用的视频流地址
      var videoUrls = [];
      if (streams.h264 && streams.h264.length > 0) {
        var h264 = streams.h264[0];
        if (h264.master_url) videoUrls.push(h264.master_url);
        if (h264.backup_urls && h264.backup_urls.length > 0) {
          for (var j = 0; j < h264.backup_urls.length; j++) {
            videoUrls.push(h264.backup_urls[j]);
          }
        }
      }
      if (streams.h265 && streams.h265.length > 0) {
        if (streams.h265[0].master_url) videoUrls.push(streams.h265[0].master_url);
      }

      // 额外的 screencast 流
      var opaque1 = videoInfo.opaque1;
      if (opaque1) {
        if (opaque1.default_screencast_stream) videoUrls.push(opaque1.default_screencast_stream);
        if (opaque1.hd_screencast_stream) videoUrls.push(opaque1.hd_screencast_stream);
      }

      // 去重
      var uniqueUrls = [];
      var seen = {};
      for (var k = 0; k < videoUrls.length; k++) {
        if (!seen[videoUrls[k]]) {
          seen[videoUrls[k]] = true;
          uniqueUrls.push(videoUrls[k]);
        }
      }

      var cached = {
        type: 'video',
        images: (item.images_list || []).map(function(img) { return { fileid: img.fileid }; }),
        imageCount: (item.images_list || []).length,
        videoUrl: uniqueUrls[0] || '',
        videoUrls: uniqueUrls,
        videoDuration: videoInfo.duration || 0,
        desc: clip(item.desc || '', 100),
        author: (item.user && item.user.nickname) || '',
        authorId: item.user_id || '',
        cachedAt: Date.now()
      };

      $persistentStore.write(JSON.stringify(cached), cacheKey(noteId));
      log('已缓存视频笔记 ' + noteId);
    }
  } catch (e) {
    log('解析 preload 失败: ' + e.message);
  }

  $done();
}

// ======================== 通知处理 ========================

/**
 * 处理点赞 - 从缓存中获取笔记信息并触发通知
 */
function handleLike() {
  var noteId = extractNoteIdFromBody($request.body);

  if (!noteId) {
    log('无法从请求体中提取 note_id');
    $done();
    return;
  }

  // 检查是否是"点赞"（而不是取消点赞）
  try {
    var resp = JSON.parse($response.body);
    if (resp.code !== 0 || !resp.data || !resp.data.inlikes) {
      log('取消点赞 ' + noteId + '，跳过保存');
      $done();
      return;
    }
  } catch (e) {
    log('解析点赞响应失败: ' + e.message);
    $done();
    return;
  }

  // 从缓存读取笔记信息
  var cached = $persistentStore.read(cacheKey(noteId));
  if (!cached) {
    log('未命中缓存: ' + noteId);
    $notification.post(
      '❤️ 已点赞',
      '浏览笔记详情页后再点赞可自动保存',
      '打开笔记详情页刷新后，下次点赞即可自动保存'
    );
    $done();
    return;
  }

  var noteData;
  try {
    noteData = JSON.parse(cached);
  } catch (e) {
    log('缓存解析失败: ' + e.message);
    $done();
    return;
  }

  // 防重复触发（30秒内不重复）
  var lastDl = $persistentStore.read(dlKey(noteId));
  if (lastDl && (Date.now() - parseInt(lastDl)) < 30000) {
    log('30秒内已触发过 ' + noteId + '，跳过');
    $done();
    return;
  }
  $persistentStore.write(String(Date.now()), dlKey(noteId));

  log('检测到点赞 ' + noteId + ' (类型: ' + noteData.type + ')');

  if (noteData.type === 'video') {
    notifyVideo(noteId, noteData);
  } else {
    notifyImages(noteId, noteData);
  }
}

/**
 * 通知图片笔记 - 将所有图片链接复制到剪贴板，通知中展示链接列表
 */
function notifyImages(noteId, noteData) {
  var images = noteData.images || [];
  if (images.length === 0) {
    $notification.post('小红书图片保存', '⚠️ 没有找到图片', '笔记中没有图片信息');
    $done();
    return;
  }

  // 收集所有可用的原始图片 URL
  var urls = [];
  for (var i = 0; i < images.length; i++) {
    var u = images[i].original || images[i].large || images[i].url;
    if (u) urls.push(u);
  }

  if (urls.length === 0) {
    $notification.post('小红书图片保存', '⚠️ 没有图片链接', '缓存中没有有效的图片 URL');
    $done();
    return;
  }

  // 剪贴板：放全部完整 URL，每行一个
  var clipboardText = urls.join('\n');

  // 第一个 URL 用于点击通知时跳转
  var firstUrl = urls[0];

  // 构建通知正文
  var author = noteData.author || '';
  var desc = noteData.desc || '';

  var bodyLines = ['📋 共 ' + urls.length + ' 个链接已复制到剪贴板:'];
  for (var i = 0; i < urls.length; i++) {
    bodyLines.push((i + 1) + '. ' + shortUrl(urls[i]));
  }
  var body = bodyLines.join('\n');

  // iOS 通知正文长度限制，截断避免被吞
  if (body.length > 400) {
    body = body.substring(0, 400) + '…\n📋 完整链接在剪贴板中';
  }

  var title = '❤️ ' + urls.length + '张图' + (author ? ' - ' + author : '');
  var subtitle = clip(desc, 60);

  $notification.post(title, subtitle, body, {
    openUrl: firstUrl,
    clipboard: clipboardText
  });

  log('通知已发送: ' + noteId + ' (' + urls.length + ' 张图)');
  $done();
}

/**
 * 通知视频笔记 - 将视频链接复制到剪贴板
 */
function notifyVideo(noteId, noteData) {
  var videoUrl = noteData.videoUrl || (noteData.videoUrls && noteData.videoUrls[0]);
  if (!videoUrl) {
    $notification.post('小红书视频保存', '⚠️ 未找到视频地址', '视频链接未获取到');
    $done();
    return;
  }

  var allUrls = noteData.videoUrls && noteData.videoUrls.length > 0
    ? noteData.videoUrls : [videoUrl];
  var clipboardText = allUrls.join('\n');

  var author = noteData.author || '';
  var desc = noteData.desc || '';
  var duration = noteData.videoDuration || 0;
  var durationSec = Math.floor(duration / 1000);

  var bodyLines = ['🎬 视频链接已复制到剪贴板:'];
  for (var i = 0; i < allUrls.length; i++) {
    bodyLines.push((i + 1) + '. ' + shortUrl(allUrls[i]));
  }
  var body = bodyLines.join('\n');

  if (body.length > 400) {
    body = body.substring(0, 400) + '…\n📋 完整链接在剪贴板中';
  }

  var title = '🎬 视频' + (author ? ' - ' + author : '');
  var subtitle = clip(desc, 60);
  var content = '时长 ' + durationSec + '秒 | 链接已复制 | 点击打开';

  $notification.post(title, subtitle, body, {
    openUrl: videoUrl,
    clipboard: clipboardText
  });

  log('视频通知已发送: ' + noteId);
  $done();
}

// ======================== 主入口 ========================

var url = $request.url || '';

if (url.indexOf(API_IMAGEFEED) !== -1) {
  cacheImagefeed();
} else if (url.indexOf(API_PRELOAD) !== -1) {
  cachePreload();
} else if (url.indexOf(API_LIKE) !== -1) {
  handleLike();
} else {
  $done();
}
