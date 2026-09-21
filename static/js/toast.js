/* 共享轻提示（toast）：独立页面通用，成功类反馈用，错误仍走页面内提示 */
(() => {
    if (window.showToast) return;
    let timer = null;
    function toast(message, icon = '✅') {
        let element = document.getElementById('shared-toast');
        if (!element) {
            element = document.createElement('div');
            element.id = 'shared-toast';
            element.setAttribute('role', 'status');
            element.setAttribute('aria-live', 'polite');
            const iconNode = document.createElement('span');
            iconNode.className = 'toast-icon';
            const textNode = document.createElement('span');
            textNode.className = 'toast-text';
            element.append(iconNode, textNode);
            document.body.append(element);
        }
        element.querySelector('.toast-icon').textContent = icon;
        element.querySelector('.toast-text').textContent = message;
        element.classList.add('show');
        clearTimeout(timer);
        timer = setTimeout(() => element.classList.remove('show'), 2600);
    }
    window.showToast = toast;
})();
