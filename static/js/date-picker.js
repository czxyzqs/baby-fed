/* 共享日期选择器：交互与睡眠分析的日期组件一致（触发条 + 展开月历）
 * 用法：window.createDatePicker({ mount, value, max, hiddenInput, onChange })
 * hiddenInput：可选，选择后同步写入该 input 并派发 change 事件 */
(() => {
    if (window.createDatePicker) return;
    const WEEKDAYS = ['日', '一', '二', '三', '四', '五', '六'];

    function toDate(dateStr) { return new Date(dateStr + 'T00:00:00'); }
    function isoOf(date) {
        const year = date.getFullYear();
        const month = String(date.getMonth() + 1).padStart(2, '0');
        const day = String(date.getDate()).padStart(2, '0');
        return `${year}-${month}-${day}`;
    }
    function display(dateStr) {
        const date = toDate(dateStr);
        return `${date.getMonth() + 1}月${date.getDate()}日 星期${WEEKDAYS[date.getDay()]}`;
    }

    window.createDatePicker = function createDatePicker(options) {
        const mount = options.mount;
        if (!mount) return null;
        const max = options.max || null;
        const hiddenInput = options.hiddenInput || null;
        const onChange = typeof options.onChange === 'function' ? options.onChange : null;
        let value = options.value || isoOf(new Date());
        let viewYear = toDate(value).getFullYear();
        let viewMonth = toDate(value).getMonth();
        let open = false;
        let outsideHandler = null;

        const root = document.createElement('div');
        root.className = 'sdp';
        const trigger = document.createElement('button');
        trigger.type = 'button';
        trigger.className = 'sdp-trigger';
        trigger.setAttribute('aria-label', '选择日期');
        const icon = document.createElement('span');
        icon.textContent = '📅';
        const label = document.createElement('span');
        label.className = 'sdp-label';
        const arrow = document.createElement('span');
        arrow.className = 'sdp-arrow';
        arrow.textContent = '▼';
        trigger.append(icon, label, arrow);

        const panel = document.createElement('div');
        panel.className = 'sdp-panel';
        const nav = document.createElement('div');
        nav.className = 'sdp-nav';
        const prev = document.createElement('button');
        prev.type = 'button';
        prev.textContent = '◀';
        prev.className = 'sdp-nav-btn';
        prev.setAttribute('aria-label', '上个月');
        const title = document.createElement('span');
        title.className = 'sdp-title';
        const next = document.createElement('button');
        next.type = 'button';
        next.textContent = '▶';
        next.className = 'sdp-nav-btn';
        next.setAttribute('aria-label', '下个月');
        nav.append(prev, title, next);
        const weekRow = document.createElement('div');
        weekRow.className = 'sdp-week';
        WEEKDAYS.forEach(name => {
            const cell = document.createElement('span');
            cell.textContent = name;
            weekRow.append(cell);
        });
        const grid = document.createElement('div');
        grid.className = 'sdp-grid';
        const todayBtn = document.createElement('button');
        todayBtn.type = 'button';
        todayBtn.className = 'sdp-today';
        todayBtn.textContent = '今天';
        panel.append(nav, weekRow, grid, todayBtn);
        root.append(trigger, panel);
        mount.replaceChildren(root);

        function refresh() {
            label.textContent = display(value);
            title.textContent = `${viewYear}年${viewMonth + 1}月`;
            grid.replaceChildren();
            const first = new Date(viewYear, viewMonth, 1);
            for (let blank = 0; blank < first.getDay(); blank += 1) {
                grid.append(document.createElement('span'));
            }
            const days = new Date(viewYear, viewMonth + 1, 0).getDate();
            const todayStr = isoOf(new Date());
            for (let day = 1; day <= days; day += 1) {
                const dateStr = `${viewYear}-${String(viewMonth + 1).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
                const cell = document.createElement('button');
                cell.type = 'button';
                cell.className = 'sdp-day';
                cell.textContent = String(day);
                if (dateStr === value) cell.classList.add('selected');
                if (dateStr === todayStr) cell.classList.add('today');
                if (max && dateStr > max) {
                    cell.classList.add('disabled');
                    cell.disabled = true;
                }
                cell.addEventListener('click', () => select(dateStr));
                grid.append(cell);
            }
            todayBtn.disabled = Boolean(max && todayStr > max);
            todayBtn.classList.toggle('disabled', todayBtn.disabled);
        }

        function select(dateStr) {
            value = dateStr;
            if (hiddenInput) {
                hiddenInput.value = dateStr;
                hiddenInput.dispatchEvent(new Event('change'));
            }
            setOpen(false);
            refresh();
            if (onChange) onChange(dateStr);
        }

        function setOpen(next) {
            open = next;
            panel.style.display = open ? 'block' : 'none';
            arrow.style.transform = open ? 'rotate(180deg)' : '';
            if (open && !outsideHandler) {
                outsideHandler = event => {
                    if (!root.contains(event.target)) setOpen(false);
                };
                document.addEventListener('click', outsideHandler);
            } else if (!open && outsideHandler) {
                document.removeEventListener('click', outsideHandler);
                outsideHandler = null;
            }
        }

        trigger.addEventListener('click', () => setOpen(!open));
        prev.addEventListener('click', () => {
            viewMonth -= 1;
            if (viewMonth < 0) { viewMonth = 11; viewYear -= 1; }
            refresh();
        });
        next.addEventListener('click', () => {
            viewMonth += 1;
            if (viewMonth > 11) { viewMonth = 0; viewYear += 1; }
            refresh();
        });
        todayBtn.addEventListener('click', () => {
            const now = new Date();
            viewYear = now.getFullYear();
            viewMonth = now.getMonth();
            select(isoOf(now));
        });

        panel.style.display = 'none';
        refresh();

        return {
            get value() { return value; },
            set value(dateStr) { value = dateStr; refresh(); }
        };
    };
})();
