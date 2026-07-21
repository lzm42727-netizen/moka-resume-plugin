/**
 * Moka 智能简历筛选 - Background Service Worker
 * 负责处理后台任务和 API 调用
 */

console.log('[Moka 筛选] Background service worker 已启动');

// 监听来自 popup 和 content script 的消息
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
    console.log('[Moka 筛选] 后台收到消息:', request.action);
    
    if (request.action === 'updateProgress') {
        // 转发进度更新到 popup
        chrome.runtime.sendMessage({
            action: 'updateProgress',
            ...request
        }).catch(() => {
            // popup 可能未打开，忽略错误
        });
    }
    
    sendResponse({ received: true });
});

// 处理扩展图标点击
chrome.action.onClicked.addListener((tab) => {
    console.log('[Moka 筛选] 扩展图标被点击，当前标签页:', tab.url);
});

// 初始化存储中的默认设置
chrome.storage.local.get('mokaSettings', (result) => {
    if (!result.mokaSettings) {
        const defaultSettings = {
            apiProvider: 'openai',
            apiEndpoint: 'https://api.openai.com/v1/chat/completions',
            apiKey: '',
            modelName: 'gpt-4o',
            autoSaveScores: false
        };
        chrome.storage.local.set({ mokaSettings: defaultSettings });
        console.log('[Moka 筛选] 已初始化默认设置');
    }
});

console.log('[Moka 筛选] Background service worker 初始化完成');
