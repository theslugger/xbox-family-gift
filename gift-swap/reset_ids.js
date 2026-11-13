/**
 * reset_ids.js —— 一键清空已采集的 idsGame/idsIAP(重新开始)
 * 触发: 任意一个你设定的 URL(默认不会自动触发), 或手动在 Surge 里运行。
 * 简单做法: 用 Surge 的"脚本"手动执行, 或删掉本地存储键。
 */
try { $persistentStore.write("", "idsGame"); } catch (e) {}
try { $persistentStore.write("", "idsIAP"); } catch (e) {}
try { $notification.post("已清空采集", "idsGame / idsIAP 已重置", "请重新加购游戏与内购"); } catch (e) {}
$done({});
