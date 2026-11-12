/*
 * Specframe: toolbar button and keyboard shortcut.
 * Nothing is injected into a page until the button is clicked (activeTab only).
 */

const BLUE = '#0d99ff';
const GREY = '#6b6b6b';
const NAME = chrome.runtime.getManifest().name;
const TITLES = {
  off: `${NAME}: click to turn on for this tab`,
  on: `${NAME} is on: hold Shift and drag. Click to turn off.`,
  blocked: `${NAME} can't run on this page`,
};

async function badge(tabId, state) {
  const on = state === 'on';
  await chrome.action.setBadgeBackgroundColor({ tabId, color: state === 'blocked' ? GREY : BLUE });
  await chrome.action.setBadgeText({ tabId, text: on ? 'ON' : state === 'blocked' ? '–' : '' });
  await chrome.action.setTitle({ tabId, title: TITLES[state] });
}

chrome.runtime.onInstalled.addListener(() => {
  chrome.action.setBadgeBackgroundColor({ color: BLUE });
  if (chrome.action.setBadgeTextColor) chrome.action.setBadgeTextColor({ color: '#ffffff' });
});

// Local files need "Allow access to file URLs". Without it Chrome may hide the tab URL,
// so a missing URL plus a "cannot access" error is treated as a local file.
async function isFileWithoutAccess(tab, err) {
  if (await chrome.extension.isAllowedFileSchemeAccess()) return false;
  const url = tab.url || tab.pendingUrl || '';
  if (url) return url.startsWith('file:');
  return /file:\/\/|cannot access contents/i.test(String((err && err.message) || err));
}

chrome.action.onClicked.addListener(async tab => {
  if (tab.id == null) return;
  const target = { tabId: tab.id };
  try {
    const [{ result: present }] = await chrome.scripting.executeScript({
      target,
      func: () => typeof window.__specframe === 'object',
    });
    if (!present) {
      // insertCSS is not subject to the page's Content-Security-Policy, unlike an injected <style>
      await chrome.scripting.insertCSS({ target, files: ['overlay.css'] });
      await chrome.scripting.executeScript({ target, files: ['engine.js', 'page.js'] });
    }
    const [{ result: on }] = await chrome.scripting.executeScript({
      target,
      func: () => window.__specframe.toggle(),
    });
    await badge(tab.id, on ? 'on' : 'off');
  } catch (err) {
    if (await isFileWithoutAccess(tab, err)) {
      await chrome.tabs.create({
        url: `chrome://extensions/?id=${chrome.runtime.id}`,
        index: tab.index + 1,
        openerTabId: tab.id,
      });
      return;
    }
    // chrome:// pages, the Web Store, the PDF viewer and similar pages refuse extensions
    await badge(tab.id, 'blocked');
    setTimeout(() => badge(tab.id, 'off').catch(() => {}), 2500);
  }
});

// A page that reloads or navigates starts with Specframe off
chrome.tabs.onUpdated.addListener((tabId, change) => {
  if (change.status === 'loading') badge(tabId, 'off').catch(() => {});
});
