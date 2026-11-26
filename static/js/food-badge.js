/* 食物标记徽标：各页「选食物」的 chip / 食物名共用，以后加标记只改这里（样式见 food-badge.css） */
(() => {
    // 把 💩 紧跟在宿主（chip 或食物名）里的食物名后面、抬成上标；食物没有该标记时原样返回。
    // 不做成探出 chip 外的角标：选食物的 chip 挨着排，探出去的角标分不清是哪个 chip 的
    function attach(host, food) {
        if (!host || !food || !food.is_constipating) return host;
        const badge = document.createElement('span');
        badge.className = 'food-badge';
        badge.textContent = '💩';
        badge.setAttribute('role', 'img');
        badge.setAttribute('aria-label', '易便秘');
        badge.title = '易便秘食材';
        host.append(badge);
        return host;
    }
    window.FoodBadge = { attach };
})();
