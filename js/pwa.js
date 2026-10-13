// Service Worker の登録と、版ズレの検知（古いキャッシュが残っていたら画面に出す）
import { APP_VERSION } from './version.js';

export function toast(message, actionLabel, onAction, ms = 6000) {
  const el = document.createElement('div');
  el.className = 'toast';
  const span = document.createElement('span');
  span.textContent = message;
  el.append(span);
  if (actionLabel) {
    const b = document.createElement('button');
    b.textContent = actionLabel;
    b.onclick = () => { el.remove(); onAction(); };
    el.append(b);
  }
  document.body.append(el);
  if (ms) setTimeout(() => el.remove(), ms);
  return el;
}

function askVersion(worker) {
  return new Promise((resolve) => {
    const ch = new MessageChannel();
    ch.port1.onmessage = (e) => resolve(e.data && e.data.version);
    worker.postMessage({ type: 'version' }, [ch.port2]);
    setTimeout(() => resolve(null), 3000);
  });
}

export async function setupPWA() {
  if (!('serviceWorker' in navigator)) return;
  try {
    const ctrl = navigator.serviceWorker.controller; // 初回インストール時は null
    const reg = await navigator.serviceWorker.register('sw.js');
    reg.update().catch(() => {});
    navigator.serviceWorker.addEventListener('controllerchange', () => {
      if (ctrl) toast('新しい版になりました', '再読み込み', () => location.reload(), 0);
    });
    if (ctrl) {
      const swVersion = await askVersion(ctrl);
      if (swVersion && swVersion !== APP_VERSION) {
        toast(`版がずれています（画面 ${APP_VERSION} / 保存 ${swVersion}）`, '再読み込み', () => location.reload(), 0);
      }
    }
  } catch (e) {
    console.warn('Service Worker を登録できません', e);
  }
}
