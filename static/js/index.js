// State - 从服务器端传递的初始化数据
    let records = Array.isArray(window.INIT_RECORDS) ? window.INIT_RECORDS : [];
    let dueSupplements = Array.isArray(window.INIT_DUE_SUPPLEMENTS) ? window.INIT_DUE_SUPPLEMENTS : [];
    let lastFetchTime = records.length > 0 ? records[0].time : null;
    let recordsVersion = null;
    let recordsLoaded = Array.isArray(window.INIT_RECORDS);
    let dashboardRecommendedSleepPosition = window.INIT_RECOMMENDED_SLEEP_POSITION;
    let dashboardRequestId = 0;
    let latestDashboardStatus = null;
    let feverModeEnabled = window.INIT_FEVER_MODE?.enabled === true;
    let feverModeSaving = false;
    let feverModeRevision = 0;
    let pollInterval = null;
    let pollTimeout = null;
    let currentTheme = 'dark';

    // Initialize
    console.log('=== CODE V2 LOADED | BUILD 2026-05-27 23:03 +0800 ===');
    document.addEventListener('DOMContentLoaded', () => {
        updateTodayDate();
        renderRecords();
        updateStats();
        updateVitaminReminder();
        startStatusPolling();

        // Load saved theme
        const savedTheme = localStorage.getItem('theme') || 'dark';
        if (savedTheme === 'light') {
            document.documentElement.setAttribute('data-theme', 'light');
            document.getElementById('theme-icon').textContent = '☀️';
            currentTheme = 'light';
        }
    });

    function updateTodayDate() {
        const dateElement = document.getElementById('today-date');
        if (!dateElement) return;
        const options = { weekday: 'long', month: 'long', day: 'numeric' };
        dateElement.textContent =
            new Date().toLocaleDateString('zh-CN', options);
    }

    function showToast(message, icon = '✅') {
        const toast = document.getElementById('toast');
        toast.querySelector('.toast-icon').textContent = icon;
        toast.querySelector('.toast-text').textContent = message;
        toast.classList.add('show');
        setTimeout(() => toast.classList.remove('show'), 3000);
    }

    // API calls
    async function getJson(url) {
        const response = await fetch(url, { cache: 'no-store' });
        if (!response.ok) throw new Error(`Request failed: ${response.status}`);
        return response.json();
    }

    async function formReq(method, url, data) {
        return fetch(url, {
            method,
            headers: { 'Content-Type': 'application/json' },
            body: data ? JSON.stringify(data) : undefined
        });
    }

    function updateRecordsVersion(response) {
        recordsVersion = response.headers.get('X-Records-Version') || recordsVersion;
    }

    function upsertLocalRecord(record) {
        dashboardRequestId += 1;
        const index = records.findIndex(item => item.id === record.id);
        if (index === -1) records.push(record);
        else records[index] = record;
        records.sort((a, b) => (b.time || '').localeCompare(a.time || ''));
        lastFetchTime = records[0]?.time || null;
        renderRecords();
        updateStats();
        updateVitaminReminder();
    }

    function removeLocalRecord(id) {
        dashboardRequestId += 1;
        records = records.filter(record => record.id !== id);
        lastFetchTime = records[0]?.time || null;
        renderRecords();
        updateStats();
        updateVitaminReminder();
    }

    async function fetchRecords() {
        const requestId = ++dashboardRequestId;
        const modeRevision = feverModeRevision;
        try {
            const response = await fetch('/api/dashboard', { cache: 'no-store' });
            if (!response.ok) throw new Error(`Request failed: ${response.status}`);
            const dashboard = await response.json();
            if (requestId !== dashboardRequestId) return;
            records = dashboard.records;
            dueSupplements = dashboard.dueSupplements;
            dashboardRecommendedSleepPosition = dashboard.recommendedSleepPosition;
            if (!feverModeSaving && modeRevision === feverModeRevision) {
                feverModeEnabled = dashboard.feverMode?.enabled === true;
            }
            updateRecordsVersion(response);
            recordsLoaded = true;
            lastFetchTime = records.length > 0 ? records[0].time : lastFetchTime;
            try { renderRecords(); } catch(e) { console.error('renderRecords error:', e); }
            try { updateStats(); } catch(e) { console.error('updateStats error:', e); }
            updateVitaminReminder();
        } catch (error) {
            if (requestId !== dashboardRequestId) return;
            console.error('Failed to refresh dashboard:', error);
            showToast('首页刷新失败，请稍后重试', '⚠️');
        }
    }

    async function autoPollRecords() {
        try {
            if (document.hidden) return;
            await fetchRecords();
        } catch (error) {
            console.warn('Auto-poll failed:', error);
        }
    }

    function startStatusPolling() {
        const millisecondsUntilNextMinute = 60000 - (Date.now() % 60000);
        pollTimeout = setTimeout(() => {
            autoPollRecords();
            pollInterval = setInterval(autoPollRecords, 60000);
        }, millisecondsUntilNextMinute);
    }

    function formatElapsedTime(record, prefix = '', suffix = '') {
        if (!record?.time) return '<span class="time-num">--</span>';
        const diffMins = Math.max(0, Math.floor((Date.now() - parseLocalTime(record.time)) / 60000));
        if (diffMins < 60) return `${prefix}<span class="time-num">${diffMins}</span>分钟${suffix}`;
        const hours = Math.floor(diffMins / 60);
        const mins = diffMins % 60;
        return mins > 0
            ? `${prefix}<span class="time-num">${hours}</span>小时<span class="time-num">${mins}</span>分钟${suffix}`
            : `${prefix}<span class="time-num">${hours}</span>小时${suffix}`;
    }

    function updateLatestDashboardStatus(status) {
        latestDashboardStatus = status;
        document.getElementById('time-since-feed').innerHTML = status.newMilk
            ? formatElapsedTime(status.newMilk, '', '前')
            : '<span class="time-num">--</span>';
        document.getElementById('time-since-diaper').innerHTML = status.diaper
            ? formatElapsedTime(status.diaper, '', '前')
            : '<span class="time-num">--</span>';

        const sleepStatus = status.sleep;
        const icon = document.getElementById('awake-icon');
        const badge = document.getElementById('sleep-position-badge');
        if (!sleepStatus) {
            icon.textContent = '👀';
            if (badge) { badge.style.display = 'none'; badge.textContent = ''; }
            document.getElementById('time-since-awake').innerHTML = '<span class="time-num">--</span>';
            return;
        }
        const isSleeping = sleepStatus.sleepType === 'sleep';
        icon.textContent = isSleeping ? '🛏️' : '👀';
        if (badge && isSleeping) { badge.style.display = 'none'; badge.textContent = ''; }
        document.getElementById('time-since-awake').innerHTML = formatElapsedTime(
            sleepStatus,
            isSleeping ? '睡了' : '醒了',
        );
    }

    function highlightNewRecord(latestTime) {
        setTimeout(() => {
            const firstItem = document.querySelector('.record-item');
            if (firstItem && records[0] && records[0].time === latestTime) {
                firstItem.classList.add('new-record');
                setTimeout(() => firstItem.classList.remove('new-record'), 1000);
            }
        }, 50);
    }

    async function createRecord(data) {
        try {
            const response = await formReq('POST', '/api/records', data);
            if (response.ok) {
                const newRecord = await response.json();
                updateRecordsVersion(response);
                upsertLocalRecord(newRecord);
                await fetchRecords();
                highlightNewRecord(newRecord.time);
                showToast('记录已保存');
            } else {
                const error = await response.json().catch(() => ({}));
                showToast(error.error || '保存失败', '❌');
            }
        } catch (error) {
            console.error('Failed to create record:', error);
            showToast('保存失败', '❌');
        }
    }

    // Modal functions
    function openModal(type) {
        const overlay = document.getElementById(`${type}-modal`);
        overlay.classList.add('active');
        document.body.style.overflow = 'hidden';

        if (type === 'supplement') {
            selectedSupplementDoseSlotId = null;
            const todaySupp = getDefaultSupplementType();
            const options = document.querySelectorAll('#supplement-type-options .form-option');
            options.forEach(o => {
                o.classList.toggle('selected', o.dataset.value === todaySupp);
            });
        } else if (type === 'health') {
            loadMedicineOptions();
        }
    }

    function selectSleepTypeForAddModal(sleepType) {
        const options = document.querySelectorAll('#sleep-type-options .form-option');
        options.forEach(o => {
            o.classList.toggle('selected', o.dataset.value === sleepType);
        });
        toggleSleepPositionFields('sleep', sleepType);
    }

    function openSleepModalWithType(sleepType) {
        openModal('sleep');
        selectSleepTypeForAddModal(sleepType);
    }

    function getCurrentOpenSleepStart() {
        const sleepEvents = records
            .filter(r => r.type === 'sleep')
            .map(r => ({ time: parseLocalTime(r.time), type: r.sleepType }))
            .filter(r => !Number.isNaN(r.time.getTime()))
            .sort((a, b) => a.time - b.time);

        let openSleep = null;
        for (const event of sleepEvents) {
            if (event.type === 'sleep') openSleep = event.time;
            if (event.type === 'awake') openSleep = null;
        }
        return openSleep;
    }

    function isBabyCurrentlySleeping() {
        if (latestDashboardStatus?.sleep) {
            return latestDashboardStatus.sleep.sleepType === 'sleep';
        }
        return Boolean(getCurrentOpenSleepStart());
    }

    function openSleepModalFromStatusCard() {
        openSleepModalWithType(isBabyCurrentlySleeping() ? 'awake' : 'sleep');
    }

    let selectedSupplementDoseSlotId = null;

    function selectSupplementOption(element) {
        selectedSupplementDoseSlotId = null;
        selectOption(element, 'supplement-type');
    }

    function openSupplementModal(preselect, doseSlotId = null) {
        openModal('supplement');
        selectedSupplementDoseSlotId = doseSlotId;
        if (preselect) {
            const options = document.querySelectorAll('#supplement-type-options .form-option');
            options.forEach(o => {
                o.classList.toggle('selected', o.dataset.value === preselect);
            });
        }
    }

    function openSupplementStatusModal() {
        const pendingList = getSupplementProgressItems().filter(item => !item.completed);
        let html = '';
        if (pendingList.length > 0) {
            html = '<div class="supplement-status-section"><h3 class="pending">⏳ 今日待服</h3>';
            pendingList.forEach(item => {
                html += `<div class="supplement-status-item pending">
                    <div class="item-icon">${item.icon}</div>
                    <div class="item-info">
                        <div class="item-name">${item.displayName}</div>
                        ${item.nextDose?.time ? `<div class="item-time">下次计划 ${item.nextDose.time}</div>` : ''}
                    </div>
                    <div class="item-badge" onclick="closeModal('supplement-status');openSupplementModal('${item.supplementId}', '${item.nextDose.doseSlotId}')">去添加</div>
                </div>`;
            });
            html += '</div>';
        } else if (dueSupplements.length > 0) {
            html = '<div style="text-align:center;padding:20px;color:var(--text-muted)">今日补剂已完成</div>';
        } else {
            html = '<div style="text-align:center;padding:20px;color:var(--text-muted)">今天无需服用补剂</div>';
        }

        document.getElementById('supplement-status-body').innerHTML = html;
        openModal('supplement-status');
    }

    let statsCalSelectedDate = null;
    let statsCalYear = 0;
    let statsCalMonth = 0;
    let statsAnalysis = null;
    const analysisCache = new Map();
    const analysisPendingLoads = new Map();
    const analysisRequestIds = { feeding: 0, sleep: 0 };

    async function loadDateAnalysis(kind, dateStr) {
        const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone || 'Asia/Shanghai';
        const key = `${kind}:${dateStr}:${timezone}`;
        if (analysisPendingLoads.has(key)) return analysisPendingLoads.get(key);
        const pending = (async () => {
            const cached = analysisCache.get(key);
            if (cached) {
                const currentVersion = await getJson('/api/records/version');
                if (currentVersion.version === cached.version) return cached;
            }
            const params = new URLSearchParams({ date: dateStr, timezone });
            const analysis = await getJson(`/api/analysis/${kind}?${params}`);
            if (analysis.type !== kind || analysis.date !== dateStr || analysis.timezone !== timezone ||
                typeof analysis.version !== 'string' || !Array.isArray(analysis.trend) || analysis.trend.length !== 7 ||
                (kind === 'feeding' ? !Array.isArray(analysis.records) : !Array.isArray(analysis.sessions) || !analysis.positionDurations)) {
                throw new Error('Invalid analysis response');
            }
            if (kind === 'sleep') {
                analysis.sessions = analysis.sessions.map(session => ({ ...session, start: new Date(session.start), end: new Date(session.end) }));
                for (const field of ['openSleep', 'positionOpenSleep']) {
                    if (analysis[field]) analysis[field] = { ...analysis[field], parsedTime: new Date(analysis[field].time) };
                }
            }
            analysisCache.delete(key);
            analysisCache.set(key, analysis);
            if (analysisCache.size > 14) analysisCache.delete(analysisCache.keys().next().value);
            return analysis;
        })();
        analysisPendingLoads.set(key, pending);
        try {
            return await pending;
        } finally {
            analysisPendingLoads.delete(key);
        }
    }

    async function showDateAnalysis(kind, dateStr) {
        const requestId = ++analysisRequestIds[kind];
        const body = document.getElementById(kind === 'feeding' ? 'stats-body' : 'sleep-analysis-body');
        if (kind === 'feeding') statsAnalysis = null;
        body.innerHTML = '<div style="text-align:center;padding:30px">加载中...</div>';
        try {
            const analysis = await loadDateAnalysis(kind, dateStr);
            if (requestId !== analysisRequestIds[kind]) return;
            if (kind === 'feeding') {
                statsAnalysis = analysis;
                renderFeedingStatsByDate(dateStr, analysis.records);
            } else {
                renderSleepAnalysisByDate(dateStr, analysis);
            }
        } catch (error) {
            if (requestId !== analysisRequestIds[kind]) return;
            body.innerHTML = `<div style="text-align:center;padding:20px;color:red">加载失败，请重试</div>`;
            const retry = document.createElement('button');
            retry.textContent = '重新加载';
            retry.onclick = () => showDateAnalysis(kind, dateStr);
            body.appendChild(retry);
        }
    }

    function buildStatsDatePickerHtml(dateStr) {
        return `<div id="stats-date-picker">
            <div class="date-picker-trigger" onclick="toggleStatsDatePicker()" style="display:flex;align-items:center;gap:8px;padding:12px;background:var(--bg-card);border:1px solid var(--border);border-radius:10px;cursor:pointer;">
                <span style="font-size:18px;">📅</span>
                <span id="stats-current-date-text" style="flex:1;color:var(--text-primary);font-size:14px;font-weight:500;">${formatSleepDateDisplay(dateStr)}</span>
                <span class="stats-date-picker-arrow" style="color:var(--text-muted);transition:transform 0.2s;">▼</span>
            </div>
            <div id="stats-date-calendar" class="sleep-calendar" style="display:none;margin-top:8px;background:var(--bg-card);border:1px solid var(--border);border-radius:10px;padding:16px;">
                <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:12px;">
                    <button onclick="statsCalPrevMonth()" style="background:none;border:none;color:var(--text-primary);font-size:18px;cursor:pointer;padding:4px;">◀</button>
                    <span id="stats-cal-title" style="font-weight:600;color:var(--text-primary);">${statsCalYear}年${statsCalMonth + 1}月</span>
                    <button onclick="statsCalNextMonth()" style="background:none;border:none;color:var(--text-primary);font-size:18px;cursor:pointer;padding:4px;">▶</button>
                </div>
                <div style="display:grid;grid-template-columns:repeat(7,1fr);gap:2px;text-align:center;font-size:12px;color:var(--text-muted);margin-bottom:8px;">
                    <span>日</span><span>一</span><span>二</span><span>三</span><span>四</span><span>五</span><span>六</span>
                </div>
                <div id="stats-cal-days" style="display:grid;grid-template-columns:repeat(7,1fr);gap:2px;"></div>
                <button onclick="goToStatsToday()" style="width:100%;margin-top:12px;padding:8px;background:linear-gradient(135deg,#8b5cf6,#ec4899);color:white;border:none;border-radius:6px;font-size:13px;cursor:pointer;">今天</button>
            </div>
        </div>`;
    }

    function toggleStatsDatePicker() {
        const calendar = document.getElementById('stats-date-calendar');
        const arrow = document.querySelector('.stats-date-picker-arrow');
        if (!calendar || !arrow) return;
        if (calendar.style.display === 'none') {
            calendar.style.display = 'block';
            arrow.style.transform = 'rotate(180deg)';
            initStatsCalendar(statsCalYear, statsCalMonth);
        } else {
            calendar.style.display = 'none';
            arrow.style.transform = 'rotate(0deg)';
        }
    }

    function initStatsCalendar(year, month) {
        const firstDay = new Date(year, month, 1);
        const lastDay = new Date(year, month + 1, 0);
        const startDay = firstDay.getDay();
        const daysInMonth = lastDay.getDate();

        statsCalYear = year;
        statsCalMonth = month;
        document.getElementById('stats-cal-title').textContent = `${year}年${month + 1}月`;

        const daysContainer = document.getElementById('stats-cal-days');
        daysContainer.innerHTML = '';

        const prevMonth = new Date(year, month, 0);
        const prevMonthDays = prevMonth.getDate();
        for (let i = startDay - 1; i >= 0; i--) {
            const day = prevMonthDays - i;
            const date = new Date(year, month - 1, day);
            const dateStr = formatSleepDate(date);
            daysContainer.innerHTML += `<div class="cal-day other-month" data-date="${dateStr}" onclick="selectStatsDate('${dateStr}')">${day}</div>`;
        }

        const todayStr = formatSleepDate(new Date());
        for (let day = 1; day <= daysInMonth; day++) {
            const date = new Date(year, month, day);
            const dateStr = formatSleepDate(date);
            let classes = 'cal-day';
            if (dateStr === todayStr) classes += ' today';
            if (dateStr === statsCalSelectedDate) classes += ' selected';
            daysContainer.innerHTML += `<div class="${classes}" data-date="${dateStr}" onclick="selectStatsDate('${dateStr}')">${day}</div>`;
        }

        const totalCells = startDay + daysInMonth;
        const remainingCells = totalCells % 7 === 0 ? 0 : 7 - (totalCells % 7);
        for (let i = 1; i <= remainingCells; i++) {
            const date = new Date(year, month + 1, i);
            const dateStr = formatSleepDate(date);
            daysContainer.innerHTML += `<div class="cal-day other-month" data-date="${dateStr}" onclick="selectStatsDate('${dateStr}')">${i}</div>`;
        }
    }

    function statsCalPrevMonth() {
        if (statsCalMonth === 0) {
            statsCalYear--;
            statsCalMonth = 11;
        } else {
            statsCalMonth--;
        }
        initStatsCalendar(statsCalYear, statsCalMonth);
    }

    function statsCalNextMonth() {
        if (statsCalMonth === 11) {
            statsCalYear++;
            statsCalMonth = 0;
        } else {
            statsCalMonth++;
        }
        initStatsCalendar(statsCalYear, statsCalMonth);
    }

    function selectStatsDate(dateStr) {
        statsCalSelectedDate = dateStr;
        return showDateAnalysis('feeding', dateStr);
    }

    function goToStatsToday() {
        const now = new Date();
        statsCalYear = now.getFullYear();
        statsCalMonth = now.getMonth();
        statsCalSelectedDate = formatSleepDate(now);
        return showDateAnalysis('feeding', statsCalSelectedDate);
    }

    function renderFeedingStatsByDate(dateStr, allRecords) {
        const body = document.getElementById('stats-body');
        const now = new Date();
        const isToday = dateStr === formatSleepDate(now);
        const cutoffTime = isToday ? now : new Date(`${dateStr}T23:59:59+08:00`);

        const dayRecords = allRecords
            .map(r => ({ ...r, parsedTime: parseLocalTime(r.time) }))
            .filter(r => !Number.isNaN(r.parsedTime.getTime()) && getChinaDateString(r.parsedTime) === dateStr && r.parsedTime <= cutoffTime);

        let html = buildStatsDatePickerHtml(dateStr);
        if (dayRecords.length === 0) {
            html += `<div style="text-align:center;padding:40px 20px;color:var(--text-muted)">
                <div style="font-size:48px;margin-bottom:16px">🍼</div>
                <div style="font-size:16px;font-weight:500">当日暂无喂养记录</div>
                <div style="font-size:13px;margin-top:8px">切换日期或先记录喂奶、尿布、补剂后再查看</div>
            </div>`;
            body.innerHTML = html;
            return;
        }

        const feeds = dayRecords.filter(r => r.type === 'feed').sort((a, b) => a.parsedTime - b.parsedTime);
        const diapers = dayRecords.filter(r => r.type === 'diaper');
        const supplementRecs = dayRecords.filter(r => r.type === 'supplement');
        const baths = dayRecords.filter(r => r.type === 'bath');

        const totalMl = feeds.reduce((sum, r) => sum + (parseInt(r.amount, 10) || 0), 0);
        const feedCount = feeds.length;
        const avgMl = feedCount > 0 ? Math.round(totalMl / feedCount) : 0;
        const newMilks = feeds.filter(r => r.isNewMilk);
        const newMilkCount = newMilks.length;
        const lastNewMilk = newMilks.length > 0 ? newMilks[newMilks.length - 1] : null;

        let lastFeedStr = '-';
        let hoursSinceLastFeed = null;
        if (lastNewMilk) {
            const diffMs = cutoffTime - lastNewMilk.parsedTime;
            hoursSinceLastFeed = Math.round(diffMs / 3600000 * 10) / 10;
            lastFeedStr = `${String(lastNewMilk.parsedTime.getHours()).padStart(2, '0')}:${String(lastNewMilk.parsedTime.getMinutes()).padStart(2, '0')}`;
        }

        const intervals = [];
        for (let i = 1; i < feeds.length; i++) {
            const diff = (feeds[i].parsedTime - feeds[i - 1].parsedTime) / 3600000;
            if (diff > 0 && diff < 12) intervals.push(diff);
        }
        const avgInterval = intervals.length > 0 ? Math.round(intervals.reduce((a, b) => a + b, 0) / intervals.length * 10) / 10 : null;

        html += `<div style="display:grid;grid-template-columns:1fr 1fr;gap:12px;margin-top:16px;margin-bottom:16px">`;
        html += `<div class="stat-item clickable" onclick="openMilkTrendModal()"><div class="stat-val">${totalMl}<span style="font-size:14px;color:#888">ml</span></div><div class="stat-lbl">总奶量 · 近7天趋势</div></div>`;
        html += `<div class="stat-item"><div class="stat-val">${feedCount}<span style="font-size:14px;color:#888">次</span></div><div class="stat-lbl">喂养次数</div></div>`;
        html += `<div class="stat-item"><div class="stat-val">${avgMl}<span style="font-size:14px;color:#888">ml</span></div><div class="stat-lbl">平均每顿</div></div>`;
        html += `<div class="stat-item"><div class="stat-val">${newMilkCount}<span style="font-size:14px;color:#888">次</span></div><div class="stat-lbl">新奶次数</div></div>`;
        if (newMilkCount > 0) {
            html += `<div class="stat-item"><div class="stat-val">${lastFeedStr}</div><div class="stat-lbl">上次泡奶</div></div>`;
            html += `<div class="stat-item"><div class="stat-val">${hoursSinceLastFeed}<span style="font-size:14px;color:#888">h</span></div><div class="stat-lbl">${isToday ? '距上次泡奶' : '距当日结束'}</div></div>`;
        }
        if (avgInterval !== null) {
            html += `<div class="stat-item"><div class="stat-val">${avgInterval}<span style="font-size:14px;color:#888">h</span></div><div class="stat-lbl">平均喂奶间隔</div></div>`;
        }
        html += `<div class="stat-item"><div class="stat-val">${diapers.length}<span style="font-size:14px;color:#888">次</span></div><div class="stat-lbl">尿布记录</div></div>`;
        html += `<div class="stat-item"><div class="stat-val">${supplementRecs.length}<span style="font-size:14px;color:#888">次</span></div><div class="stat-lbl">补剂</div></div>`;
        html += `</div>`;

        if (diapers.length > 0) {
            const dTypes = { wet: 0, dirty: 0 };
            diapers.forEach(r => {
                const type = r.diaperType || 'other';
                if (type === 'wet' || type === 'both') dTypes.wet++;
                if (type === 'dirty' || type === 'both') dTypes.dirty++;
            });
            html += `<div style="margin-top:16px"><div style="font-weight:600;margin-bottom:8px;color:#888">🚽 尿布详情</div>`;
            const dLabels = { wet: '💧 尿湿', dirty: '💩 便便' };
            for (const [type, count] of Object.entries(dTypes)) {
                if (count > 0) {
                    html += `<div style="display:flex;justify-content:space-between;padding:4px 0;font-size:14px">
                        <span>${dLabels[type] || type}</span><span>${count}次</span>
                    </div>`;
                }
            }
            html += `</div>`;
        }

        if (supplementRecs.length > 0) {
            html += `<div style="margin-top:16px"><div style="font-weight:600;margin-bottom:8px;color:#888">💊 补剂</div>`;
            supplementRecs.forEach(r => {
                const suppLabels = { D3: '☀️ D3', AD: '🌟 AD', iron: '🔩 铁', probiotic: '🫙 益生菌' };
                html += `<div style="display:flex;justify-content:space-between;padding:4px 0;font-size:14px">
                    <span>${r.detail || r.label || suppLabels[r.supplementType] || '💊 补剂'}</span>
                    <span style="color:#888">${r.parsedTime.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })}</span>
                </div>`;
            });
            html += `</div>`;
        }

        if (baths.length > 0) {
            html += `<div style="margin-top:16px"><div style="font-weight:600;margin-bottom:8px;color:#888">🛁 洗澡</div>`;
            baths.forEach(r => {
                html += `<div style="display:flex;justify-content:space-between;padding:4px 0;font-size:14px">
                    <span>🛁 洗澡</span>
                    <span style="color:#888">${r.parsedTime.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })}</span>
                </div>`;
            });
            html += `</div>`;
        }

        html += `<div style="margin-top:20px;text-align:center;color:#888;font-size:12px">
            数据区间：${dateStr.replace(/^(\d{4})-(\d{2})-(\d{2})$/, '$2/$3')} 00:00 ~ ${isToday ? '现在' : '23:59'}
        </div>`;

        html += `<div style="margin-top:20px">
            <button id="ai-analysis-btn" onclick="doAiAnalysis()" style="
                width:100%;padding:12px;border:none;border-radius:12px;
                background:linear-gradient(135deg,#8b5cf6,#ec4899);
                color:white;font-size:14px;font-weight:600;cursor:pointer;
            ">🤖 AI 智能分析</button>
            <div id="ai-analysis-result" style="margin-top:12px;display:none;max-height:400px;overflow-y:auto;background:var(--bg-card);border:1px solid var(--border);border-radius:12px;padding:14px;line-height:1.8;font-size:14px;white-space:pre-wrap;word-break:break-word"></div>
            <div id="ai-analysis-spinner" style="display:none;margin-top:12px;text-align:center;padding:20px">
                <div style="width:32px;height:32px;border:3px solid var(--border);border-top-color:#8b5cf6;border-radius:50%;animation:spin 0.8s linear infinite;margin:0 auto 8px"></div>
                <div style="font-size:13px;color:#888">AI 正在分析...</div>
            </div>
        </div>`;

        body.innerHTML = html;
    }

    function openMilkTrendModal() {
        const modal = document.getElementById('feeding-trend-modal');
        const body = document.getElementById('feeding-trend-body');
        const selectedDate = statsCalSelectedDate || getChinaDateString();
        if (!statsAnalysis || statsAnalysis.date !== selectedDate) return;
        const trendData = statsAnalysis.trend;
        const maxMl = Math.max(...trendData.map(item => item.totalMl), 1);
        const selectedDay = trendData[trendData.length - 1];
        const avgMl = Math.round(trendData.reduce((sum, item) => sum + item.totalMl, 0) / trendData.length);

        let html = `<div style="display:grid;grid-template-columns:1fr 1fr;gap:12px;margin-bottom:16px">
            <div class="stat-item"><div class="stat-val">${selectedDay.totalMl}<span style="font-size:14px;color:#888">ml</span></div><div class="stat-lbl">${formatSleepDateDisplay(selectedDate)}</div></div>
            <div class="stat-item"><div class="stat-val">${avgMl}<span style="font-size:14px;color:#888">ml</span></div><div class="stat-lbl">近7日平均</div></div>
        </div>`;

        html += `<div style="background:var(--bg-card);border:1px solid var(--border);border-radius:12px;padding:16px;margin-bottom:16px">
            <div style="font-size:13px;color:var(--text-muted);margin-bottom:12px">近一周奶量趋势</div>
            <div style="display:flex;align-items:flex-end;gap:10px;height:180px;">`;
        html += trendData.map(item => {
            const date = new Date(`${item.dateStr}T12:00:00+08:00`);
            const barHeight = Math.max(Math.round(item.totalMl / maxMl * 120), item.totalMl > 0 ? 16 : 6);
            const isSelected = item.dateStr === selectedDate;
            return `<div style="flex:1;display:flex;flex-direction:column;align-items:center;justify-content:flex-end;height:100%">
                <div style="font-size:12px;color:${isSelected ? 'var(--accent-feed)' : 'var(--text-secondary)'};font-weight:${isSelected ? '700' : '500'};margin-bottom:6px">${item.totalMl}ml</div>
                <div style="width:100%;max-width:32px;height:${barHeight}px;background:${isSelected ? 'linear-gradient(180deg,#00d9a5,#22c55e)' : 'linear-gradient(180deg,#8b5cf6,#ec4899)'};border-radius:10px 10px 4px 4px;opacity:${isSelected ? '1' : '0.78'}"></div>
                <div style="font-size:11px;color:var(--text-muted);margin-top:8px">${date.getMonth() + 1}/${date.getDate()}</div>
            </div>`;
        }).join('');
        html += `</div></div>`;

        html += `<div style="background:var(--bg-card);border:1px solid var(--border);border-radius:12px;padding:14px">
            <div style="font-size:13px;color:var(--text-muted);margin-bottom:8px">每日明细</div>`;
        html += trendData.map(item => {
            const date = new Date(`${item.dateStr}T12:00:00+08:00`);
            const weekDay = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'][date.getDay()];
            const isSelected = item.dateStr === selectedDate;
            return `<div style="display:flex;justify-content:space-between;align-items:center;padding:8px 0;border-bottom:1px solid var(--border);${isSelected ? 'color:var(--accent-feed);font-weight:600;' : ''}">
                <span>${date.getMonth() + 1}月${date.getDate()}日 ${weekDay}${isSelected ? ' · 当前查看' : ''}</span>
                <span>${item.totalMl}ml · 泡奶${item.newMilkCount}次</span>
            </div>`;
        }).join('');
        html += `</div>`;

        body.innerHTML = html;
        modal.classList.add('active');
        document.body.style.overflow = 'hidden';
    }

    async function openStatsModal() {
        const modal = document.getElementById('stats-modal');
        const body = document.getElementById('stats-body');
        modal.classList.add('active');
        document.body.style.overflow = 'hidden';
        body.innerHTML = '<div style="text-align:center;padding:30px">加载中...</div>';

        const now = new Date();
        statsCalYear = now.getFullYear();
        statsCalMonth = now.getMonth();
        statsCalSelectedDate = formatSleepDate(now);
        await showDateAnalysis('feeding', statsCalSelectedDate);
    }

    // Sleep Analysis Date Picker State
    let sleepCalCurrentDate = new Date();
    let sleepCalSelectedDate = null;
    let sleepCalYear = 0;
    let sleepCalMonth = 0;
    function formatSleepDate(date) {
        const y = date.getFullYear();
        const m = String(date.getMonth() + 1).padStart(2, '0');
        const d = String(date.getDate()).padStart(2, '0');
        return `${y}-${m}-${d}`;
    }

    function formatSleepDateDisplay(dateStr) {
        const date = new Date(dateStr);
        const now = new Date();
        const todayStr = formatSleepDate(now);
        const yesterday = new Date(now);
        yesterday.setDate(yesterday.getDate() - 1);
        const yesterdayStr = formatSleepDate(yesterday);

        const year = date.getFullYear();
        const month = date.getMonth() + 1;
        const day = date.getDate();
        const weekDay = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'][date.getDay()];

        if (dateStr === todayStr) {
            return `${month}月${day}日 (${weekDay}) - 今天`;
        } else if (dateStr === yesterdayStr) {
            return `${month}月${day}日 (${weekDay}) - 昨天`;
        } else {
            return `${year}年${month}月${day}日 (${weekDay})`;
        }
    }

    function toggleSleepDatePicker() {
        const calendar = document.getElementById('sleep-date-calendar');
        const arrow = document.querySelector('.date-picker-arrow');
        if (calendar.style.display === 'none') {
            calendar.style.display = 'block';
            arrow.style.transform = 'rotate(180deg)';
            initSleepCalendar(sleepCalYear, sleepCalMonth);
        } else {
            calendar.style.display = 'none';
            arrow.style.transform = 'rotate(0deg)';
        }
    }

    function initSleepCalendar(year, month) {
        const firstDay = new Date(year, month, 1);
        const lastDay = new Date(year, month + 1, 0);
        const startDay = firstDay.getDay();
        const daysInMonth = lastDay.getDate();

        sleepCalYear = year;
        sleepCalMonth = month;

        document.getElementById('sleep-cal-title').textContent = `${year}年${month + 1}月`;

        const daysContainer = document.getElementById('sleep-cal-days');
        daysContainer.innerHTML = '';

        // Previous month days
        const prevMonth = new Date(year, month, 0);
        const prevMonthDays = prevMonth.getDate();
        for (let i = startDay - 1; i >= 0; i--) {
            const day = prevMonthDays - i;
            const date = new Date(year, month - 1, day);
            const dateStr = formatSleepDate(date);
            daysContainer.innerHTML += `<div class="cal-day other-month" data-date="${dateStr}" onclick="selectSleepDate('${dateStr}')">${day}</div>`;
        }

        // Current month days
        const now = new Date();
        const todayStr = formatSleepDate(now);
        for (let day = 1; day <= daysInMonth; day++) {
            const date = new Date(year, month, day);
            const dateStr = formatSleepDate(date);
            let classes = 'cal-day';
            if (dateStr === todayStr) classes += ' today';
            if (dateStr === sleepCalSelectedDate) classes += ' selected';
            daysContainer.innerHTML += `<div class="${classes}" data-date="${dateStr}" onclick="selectSleepDate('${dateStr}')">${day}</div>`;
        }

        // Next month days
        const totalCells = startDay + daysInMonth;
        const remainingCells = totalCells % 7 === 0 ? 0 : 7 - (totalCells % 7);
        for (let i = 1; i <= remainingCells; i++) {
            const date = new Date(year, month + 1, i);
            const dateStr = formatSleepDate(date);
            daysContainer.innerHTML += `<div class="cal-day other-month" data-date="${dateStr}" onclick="selectSleepDate('${dateStr}')">${i}</div>`;
        }
    }

    function sleepCalPrevMonth() {
        if (sleepCalMonth === 0) {
            sleepCalYear--;
            sleepCalMonth = 11;
        } else {
            sleepCalMonth--;
        }
        initSleepCalendar(sleepCalYear, sleepCalMonth);
    }

    function sleepCalNextMonth() {
        if (sleepCalMonth === 11) {
            sleepCalYear++;
            sleepCalMonth = 0;
        } else {
            sleepCalMonth++;
        }
        initSleepCalendar(sleepCalYear, sleepCalMonth);
    }

    function selectSleepDate(dateStr) {
        sleepCalSelectedDate = dateStr;
        return showDateAnalysis('sleep', dateStr);
    }

    function goToSleepToday() {
        const now = new Date();
        sleepCalYear = now.getFullYear();
        sleepCalMonth = now.getMonth();
        sleepCalSelectedDate = formatSleepDate(now);
        return showDateAnalysis('sleep', sleepCalSelectedDate);
    }

    function formatSleepDurationMinutes(totalMinutes) {
        const roundedMinutes = Math.max(0, Math.round(totalMinutes));
        if (roundedMinutes < 60) {
            return `${roundedMinutes}分钟`;
        }
        const hours = Math.floor(roundedMinutes / 60);
        const minutes = roundedMinutes % 60;
        return minutes > 0 ? `${hours}小时${minutes}分钟` : `${hours}小时`;
    }

    function formatCompactSleepDuration(totalMinutes) {
        const roundedMinutes = Math.max(0, Math.round(totalMinutes));
        const hours = Math.floor(roundedMinutes / 60);
        const minutes = roundedMinutes % 60;
        if (hours <= 0) return `${minutes}m`;
        if (minutes <= 0) return `${hours}h`;
        return `${hours}h${minutes}m`;
    }

    function getOngoingSleepSession(index, dateStr, now) {
        if (!index.openSleep || index.openSleepDate !== dateStr) return null;
        const isToday = dateStr === formatSleepDate(now);
        const end = isToday ? now : new Date(dateStr + 'T23:59:59');
        const durationMs = end - index.openSleep.parsedTime;
        if (!(durationMs > 0)) return null;
        return {
            start: index.openSleep.parsedTime,
            end,
            durationMs,
            ongoing: isToday,
            isCrossDay: !isToday,
            sleepPosition: index.openSleep.sleepPosition
        };
    }

    function buildSleepSessionsForDate(analysis, dateStr, now = new Date()) {
        const sessions = analysis.date === dateStr ? analysis.sessions.slice() : [];
        const ongoing = getOngoingSleepSession(analysis, dateStr, now);
        if (ongoing) sessions.push(ongoing);
        return sessions;
    }

    function buildSleepTrendData(selectedDate, analysis, now = new Date()) {
        return analysis.trend.map(day => {
            const ongoing = getOngoingSleepSession(analysis, day.dateStr, now);
            const totalMinutes = Math.floor((day.totalDurationMs + (ongoing?.durationMs || 0)) / 60000);
            const sessionCount = day.sessionCount + (ongoing ? 1 : 0);
            return { dateStr: day.dateStr, totalMinutes, sessionCount };
        });
    }

    function buildSleepTrendHtml(selectedDate, allRecords, now = new Date()) {
        const trendData = buildSleepTrendData(selectedDate, allRecords, now);
        const maxMinutes = Math.max(...trendData.map(item => item.totalMinutes), 60);
        const avgMinutes = Math.round(trendData.reduce((sum, item) => sum + item.totalMinutes, 0) / trendData.length);

        let html = `<div style="background:var(--bg-card);border:1px solid var(--border);border-radius:12px;padding:14px;margin-bottom:16px">
            <div style="display:flex;justify-content:space-between;align-items:baseline;margin-bottom:12px">
                <div style="font-size:13px;color:var(--text-muted)">近七日睡眠时长趋势</div>
                <div style="font-size:12px;color:var(--text-muted)">平均 ${formatSleepDurationMinutes(avgMinutes)}</div>
            </div>
            <div style="display:flex;align-items:flex-end;gap:8px;height:150px;">`;

        html += trendData.map(item => {
            const date = new Date(`${item.dateStr}T12:00:00+08:00`);
            const isSelected = item.dateStr === selectedDate;
            const barHeight = Math.max(Math.round(item.totalMinutes / maxMinutes * 110), item.totalMinutes > 0 ? 14 : 5);
            const color = isSelected ? 'linear-gradient(180deg,#7c3aed,#ec4899)' : 'linear-gradient(180deg,#93c5fd,#22c55e)';
            return `<div style="flex:1;display:flex;flex-direction:column;align-items:center;justify-content:flex-end;height:100%;min-width:0">
                <div style="font-size:11px;color:${isSelected ? 'var(--accent-sleep,#7c3aed)' : 'var(--text-secondary)'};font-weight:${isSelected ? '700' : '500'};margin-bottom:6px;white-space:nowrap">${formatCompactSleepDuration(item.totalMinutes)}</div>
                <div style="width:100%;max-width:30px;height:${barHeight}px;background:${color};border-radius:8px 8px 3px 3px;opacity:${isSelected ? '1' : '0.78'}" title="${item.dateStr} ${formatSleepDurationMinutes(item.totalMinutes)} ${item.sessionCount}次"></div>
                <div style="font-size:10px;color:var(--text-muted);margin-top:8px;white-space:nowrap">${date.getMonth() + 1}/${date.getDate()}</div>
            </div>`;
        }).join('');

        html += `</div></div>`;
        return html;
    }

    function getSleepPositionDurations(analysis, now = new Date()) {
        const durations = { ...analysis.positionDurations };
        const openSleep = analysis.positionOpenSleep;
        if (openSleep) {
            const durationMs = now - openSleep.parsedTime;
            if (durationMs > 0 && durations[openSleep.sleepPosition] !== undefined) {
                durations[openSleep.sleepPosition] += durationMs;
            }
        }

        return durations;
    }

    function buildSleepPositionHistoryHtml(allRecords, now = new Date()) {
        const labels = { left: '左侧睡', right: '右侧睡', back: '平躺' };
        const colors = { left: '#0ea5e9', right: '#f97316', back: '#64748b' };
        const durations = getSleepPositionDurations(allRecords, now);
        const positions = ['left', 'right', 'back'];
        const totalDuration = positions.reduce((sum, position) => sum + (durations[position] || 0), 0);

        const rows = positions.map(position => {
            const durationMs = durations[position] || 0;
            const durationMinutes = durationMs / 60000;
            const percent = totalDuration > 0 ? Math.round((durationMs / totalDuration) * 100) : 0;
            const barWidth = totalDuration > 0 ? Math.max(percent, durationMs > 0 ? 3 : 0) : 0;
            return `<div style="display:grid;grid-template-columns:64px 1fr auto;align-items:center;gap:10px;padding:6px 0">
                <div style="font-size:13px;color:var(--text-secondary);font-weight:500">${labels[position]}</div>
                <div style="height:8px;background:var(--bg-secondary);border-radius:999px;overflow:hidden">
                    <div style="height:100%;width:${barWidth}%;background:${colors[position]};border-radius:999px"></div>
                </div>
                <div style="font-size:13px;color:var(--text-primary);font-weight:600;white-space:nowrap">${formatSleepDurationMinutes(durationMinutes)}</div>
            </div>`;
        }).join('');

        return `<div style="background:var(--bg-card);border:1px solid var(--border);border-radius:12px;padding:14px;margin-bottom:16px">
            <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:10px">
                <div style="font-size:13px;color:var(--text-muted)">历史累计睡姿</div>
                <div style="font-size:12px;color:var(--text-muted)">共 ${formatSleepDurationMinutes(totalDuration / 60000)}</div>
            </div>
            ${rows}
        </div>`;
    }

    async function setFeverMode(enabled) {
        if (feverModeSaving) return;
        feverModeSaving = true;
        feverModeRevision += 1;
        renderFeverMode();
        try {
            const response = await formReq('PUT', '/api/fever-mode', { enabled });
            if (!response.ok) throw new Error(`Request failed: ${response.status}`);
            const settings = await response.json();
            if (settings.enabled !== enabled) throw new Error('Unexpected fever mode response');
            feverModeEnabled = settings.enabled;
            feverModeRevision += 1;
            renderFeverMode();
            if (enabled) {
                if (document.getElementById('health-management-modal').classList.contains('active')) {
                    closeModal('health-management');
                }
                document.getElementById('fever-panel').scrollIntoView({ behavior: 'smooth', block: 'start' });
            }
            showToast(enabled ? '发烧模式已开启' : '发烧模式已结束，历史记录已保留');
        } catch (error) {
            showToast('发烧模式设置失败，请重试', '❌');
        } finally {
            feverModeSaving = false;
            renderFeverMode();
        }
    }

    function openQuickHealthRecord(healthType) {
        openModal('health');
        document.querySelectorAll('#health-type-options .form-option').forEach(option => {
            option.classList.toggle('selected', option.dataset.value === healthType);
        });
        toggleHealthFields('health', healthType);
        const field = healthType === 'temperature'
            ? document.querySelector('#health-form [name="temperature"]')
            : document.getElementById('health-medicine-name');
        field.focus({ preventScroll: true });
    }

    function formatFeverRecordTime(record, now) {
        const recordedAt = parseLocalTime(record.time);
        const minutes = Math.max(0, Math.floor((now - recordedAt) / 60000));
        const elapsed = minutes < 1 ? '刚刚'
            : minutes < 60 ? `${minutes} 分钟前`
            : `${Math.floor(minutes / 60)} 小时${minutes % 60 ? ` ${minutes % 60} 分钟` : ''}前`;
        const time = recordedAt.toLocaleString('zh-CN', {
            timeZone: 'Asia/Shanghai', month: 'numeric', day: 'numeric',
            hour: '2-digit', minute: '2-digit', hour12: false
        });
        return `${time} · ${elapsed}`;
    }

    function renderFeverMode() {
        document.getElementById('fever-panel').hidden = !feverModeEnabled;
        document.getElementById('fever-mode-toggle').setAttribute('aria-checked', String(feverModeEnabled));
        document.getElementById('fever-mode-state').textContent = feverModeSaving
            ? '保存中…' : feverModeEnabled ? '已开启' : '已关闭';
        document.querySelectorAll('[data-fever-mode-control]').forEach(button => {
            button.disabled = feverModeSaving;
        });
        if (!feverModeEnabled) return;

        const now = new Date();
        const healthRecords = getRecentHealthRecords(records, now)
            .filter(record => parseLocalTime(record.time) <= now)
            .reverse();
        const temperature = healthRecords.find(record => record.healthType === 'temperature');
        const medicine = healthRecords.find(record => record.healthType === 'medicine');
        document.getElementById('fever-latest-temperature').textContent = temperature
            ? `${temperature.temperature} °C` : '暂无记录';
        document.getElementById('fever-temperature-time').textContent = temperature
            ? formatFeverRecordTime(temperature, now) : '近 72 小时未记录';
        document.getElementById('fever-latest-medicine').textContent = medicine?.medicineName || '暂无记录';
        document.getElementById('fever-medicine-dose').textContent = medicine
            ? medicine.medicineDose ? `剂量：${medicine.medicineDose}` : '未填写剂量' : '';
        document.getElementById('fever-medicine-time').textContent = medicine
            ? formatFeverRecordTime(medicine, now) : '近 72 小时未记录';
        document.getElementById('fever-empty').hidden = healthRecords.length > 0;
        document.getElementById('fever-view-all').hidden = healthRecords.length === 0;
        document.getElementById('fever-recent-records').innerHTML = healthRecords.slice(0, 4).map(record => {
            const isTemperature = record.healthType === 'temperature';
            const detail = isTemperature ? `体温 ${record.temperature} °C`
                : `${record.medicineName || '用药'}${record.medicineDose ? ` · ${record.medicineDose}` : ''}`;
            return `<li><button type="button" class="fever-record" data-record-id="${escapeHtml(record.id)}" onclick="openEditModal('health', this.dataset.recordId)" aria-label="修改${escapeHtml(detail)}">
                <span aria-hidden="true">${isTemperature ? '🌡️' : '💊'}</span>
                <span class="fever-record-copy"><strong>${escapeHtml(detail)}</strong><small>${escapeHtml(formatFeverRecordTime(record, now))}</small>${record.note ? `<small>${escapeHtml(record.note)}</small>` : ''}</span>
                <span aria-hidden="true">›</span>
            </button></li>`;
        }).join('');
    }

    function getRecentHealthRecords(allRecords, now = new Date()) {
        const cutoff = now.getTime() - 72 * 60 * 60 * 1000;
        return allRecords
            .filter(record => record.type === 'health' && parseLocalTime(record.time).getTime() >= cutoff)
            .sort((a, b) => parseLocalTime(a.time) - parseLocalTime(b.time));
    }

    function updateFeverAnalysisVisibility() {
        const button = document.getElementById('fever-analysis-btn');
        if (button) button.style.display = getRecentHealthRecords(records).length > 0 ? '' : 'none';
    }

    async function openFeverAnalysisModal() {
        const modal = document.getElementById('fever-analysis-modal');
        const body = document.getElementById('fever-analysis-body');
        modal.classList.add('active');
        document.body.style.overflow = 'hidden';
        body.innerHTML = '<div style="text-align:center;padding:30px">加载中...</div>';

        try {
            const healthRecords = getRecentHealthRecords(await getJson('/api/records'));
            if (healthRecords.length === 0) {
                closeModal('fever-analysis');
                updateFeverAnalysisVisibility();
                return;
            }
            const temperatures = healthRecords.filter(record => record.healthType === 'temperature');
            const medicines = healthRecords.filter(record => record.healthType === 'medicine');
            const latestTemperature = temperatures.length ? temperatures[temperatures.length - 1] : null;
            const highestTemperature = temperatures.length
                ? Math.max(...temperatures.map(record => Number(record.temperature) || 0))
                : null;
            const formatTime = record => parseLocalTime(record.time).toLocaleString('zh-CN', {
                month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false
            });

            let html = '<div style="font-size:13px;color:var(--text-muted);margin-bottom:16px">近 72 小时的体温与服药记录</div>';
            html += '<div style="display:grid;grid-template-columns:repeat(3,1fr);gap:10px;margin-bottom:20px">';
            const highestTemperatureText = highestTemperature === null
                ? '--'
                : `${Number.isInteger(highestTemperature) ? highestTemperature : highestTemperature.toFixed(1)}°C`;
            html += `<div class="stat-item"><div class="stat-val">${highestTemperatureText}</div><div class="stat-lbl">最高体温</div></div>`;
            html += `<div class="stat-item"><div class="stat-val">${latestTemperature ? `${latestTemperature.temperature}°C` : '--'}</div><div class="stat-lbl">最近体温</div></div>`;
            html += `<div class="stat-item"><div class="stat-val">${medicines.length}<span style="font-size:14px;color:#888">次</span></div><div class="stat-lbl">服药记录</div></div>`;
            html += '</div><div style="font-weight:600;margin-bottom:10px;color:var(--text-secondary);font-size:13px">记录时间线</div>';
            html += healthRecords.slice().reverse().map(record => {
                const isTemperature = record.healthType === 'temperature';
                const detail = isTemperature
                    ? `体温 ${record.temperature}°C`
                    : `服药 ${record.medicineName || ''}${record.medicineDose ? ` · ${record.medicineDose}` : ''}`;
                return `<div style="display:flex;gap:12px;padding:12px 0;border-bottom:1px solid var(--border)"><div style="font-size:22px">${isTemperature ? '🌡️' : '💊'}</div><div style="flex:1"><div style="font-size:14px;font-weight:500">${escapeHtml(detail)}</div>${record.note ? `<div style="font-size:12px;color:var(--text-muted);margin-top:3px">${escapeHtml(record.note)}</div>` : ''}</div><div style="font-size:12px;color:var(--text-muted);white-space:nowrap">${formatTime(record)}</div></div>`;
            }).join('');
            body.innerHTML = html;
        } catch (error) {
            body.innerHTML = '<div style="text-align:center;padding:20px;color:#ef4444">加载失败，请稍后重试</div>';
        }
    }

    async function openSleepAnalysisModal() {
        const modal = document.getElementById('sleep-analysis-modal');
        modal.classList.add('active');
        document.body.style.overflow = 'hidden';
        const now = new Date();
        sleepCalCurrentDate = now;
        sleepCalYear = now.getFullYear();
        sleepCalMonth = now.getMonth();
        sleepCalSelectedDate = formatSleepDate(now);
        await showDateAnalysis('sleep', sleepCalSelectedDate);
    }

    function renderSleepAnalysisByDate(dateStr, allRecords) {
        const body = document.getElementById('sleep-analysis-body');
        const now = new Date();
        const sessions = buildSleepSessionsForDate(allRecords, dateStr, now);

        if (sessions.length === 0) {
            body.innerHTML = `
                <div id="sleep-date-picker">
                    <div class="date-picker-trigger" onclick="toggleSleepDatePicker()" style="display:flex;align-items:center;gap:8px;padding:12px;background:var(--bg-card);border:1px solid var(--border);border-radius:10px;cursor:pointer;">
                        <span style="font-size:18px;">📅</span>
                        <span id="sleep-current-date-text" style="flex:1;color:var(--text-primary);font-size:14px;font-weight:500;">${formatSleepDateDisplay(dateStr)}</span>
                        <span class="date-picker-arrow" style="color:var(--text-muted);transition:transform 0.2s;">▼</span>
                    </div>
                    <div id="sleep-date-calendar" class="sleep-calendar" style="display:none;margin-top:8px;background:var(--bg-card);border:1px solid var(--border);border-radius:10px;padding:16px;">
                        <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:12px;">
                            <button onclick="sleepCalPrevMonth()" style="background:none;border:none;color:var(--text-primary);font-size:18px;cursor:pointer;padding:4px;">◀</button>
                            <span id="sleep-cal-title" style="font-weight:600;color:var(--text-primary);">${sleepCalYear}年${sleepCalMonth + 1}月</span>
                            <button onclick="sleepCalNextMonth()" style="background:none;border:none;color:var(--text-primary);font-size:18px;cursor:pointer;padding:4px;">▶</button>
                        </div>
                        <div style="display:grid;grid-template-columns:repeat(7,1fr);gap:2px;text-align:center;font-size:12px;color:var(--text-muted);margin-bottom:8px;">
                            <span>日</span><span>一</span><span>二</span><span>三</span><span>四</span><span>五</span><span>六</span>
                        </div>
                        <div id="sleep-cal-days" style="display:grid;grid-template-columns:repeat(7,1fr);gap:2px;"></div>
                        <button onclick="goToSleepToday()" style="width:100%;margin-top:12px;padding:8px;background:var(--accent-sleep,#7c3aed);color:white;border:none;border-radius:6px;font-size:13px;cursor:pointer;">今天</button>
                    </div>
                </div>
                ${buildSleepPositionHistoryHtml(allRecords, now)}
                <div style="text-align:center;padding:40px 20px;color:var(--text-muted)">
                    <div style="font-size:48px;margin-bottom:16px">🛏️</div>
                    <div style="font-size:16px;font-weight:500">当日暂无睡眠记录</div>
                    <div style="font-size:13px;margin-top:8px">记录宝宝睡着和醒来时间，即可查看分析</div>
                </div>
            `;
            return;
        }

        const totalSleepMs = sessions.reduce((sum, s) => sum + s.durationMs, 0);

        const totalSleepMins = Math.floor(totalSleepMs / 60000);
        const sleepText = formatSleepDurationMinutes(totalSleepMins);

        const totalSleepH = (totalSleepMs / 3600000).toFixed(1);

        // Build session duration list for bar chart
        const sessionDurations = sessions.map(s => s.ongoing ? (now - s.start) / 60000 : s.durationMs / 60000); // minutes
        const maxDuration = Math.max(...sessionDurations, 30);
        const barHeight = 120;

        let html = `<div id="sleep-date-picker">
            <div class="date-picker-trigger" onclick="toggleSleepDatePicker()" style="display:flex;align-items:center;gap:8px;padding:12px;background:var(--bg-card);border:1px solid var(--border);border-radius:10px;cursor:pointer;">
                <span style="font-size:18px;">📅</span>
                <span id="sleep-current-date-text" style="flex:1;color:var(--text-primary);font-size:14px;font-weight:500;">${formatSleepDateDisplay(dateStr)}</span>
                <span class="date-picker-arrow" style="color:var(--text-muted);transition:transform 0.2s;">▼</span>
            </div>
            <div id="sleep-date-calendar" class="sleep-calendar" style="display:none;margin-top:8px;background:var(--bg-card);border:1px solid var(--border);border-radius:10px;padding:16px;">
                <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:12px;">
                    <button onclick="sleepCalPrevMonth()" style="background:none;border:none;color:var(--text-primary);font-size:18px;cursor:pointer;padding:4px;">◀</button>
                    <span id="sleep-cal-title" style="font-weight:600;color:var(--text-primary);">${sleepCalYear}年${sleepCalMonth + 1}月</span>
                    <button onclick="sleepCalNextMonth()" style="background:none;border:none;color:var(--text-primary);font-size:18px;cursor:pointer;padding:4px;">▶</button>
                </div>
                <div style="display:grid;grid-template-columns:repeat(7,1fr);gap:2px;text-align:center;font-size:12px;color:var(--text-muted);margin-bottom:8px;">
                    <span>日</span><span>一</span><span>二</span><span>三</span><span>四</span><span>五</span><span>六</span>
                </div>
                <div id="sleep-cal-days" style="display:grid;grid-template-columns:repeat(7,1fr);gap:2px;"></div>
                <button onclick="goToSleepToday()" style="width:100%;margin-top:12px;padding:8px;background:var(--accent-sleep,#7c3aed);color:white;border:none;border-radius:6px;font-size:13px;cursor:pointer;">今天</button>
            </div>
        </div>`;

        html += `<div style="display:grid;grid-template-columns:1fr 1fr;gap:12px;margin-top:16px;margin-bottom:20px">`;
        html += `<div class="stat-item"><div class="stat-val">${sleepText}</div><div class="stat-lbl">当日总睡眠</div></div>`;
        html += `<div class="stat-item"><div class="stat-val">${sessions.length}<span style="font-size:14px;color:#888">次</span></div><div class="stat-lbl">睡眠次数</div></div>`;
        html += `</div>`;

        html += buildSleepTrendHtml(dateStr, allRecords, now);
        html += buildSleepPositionHistoryHtml(allRecords, now);

        const sleepPositionLabels = { left: '左侧睡', right: '右侧睡', back: '平躺' };
        const sleepPositionDurations = { left: 0, right: 0, back: 0 };
        sessions.forEach(s => {
            if (s.sleepPosition && sleepPositionDurations[s.sleepPosition] !== undefined) {
                const durationMins = s.ongoing ? (now - s.start) / 60000 : s.durationMs / 60000;
                sleepPositionDurations[s.sleepPosition] += durationMins;
            }
        });
        const positionEntries = Object.entries(sleepPositionDurations).filter(([, duration]) => duration > 0);
        if (positionEntries.length > 0) {
            html += `<div style="background:var(--bg-card);border:1px solid var(--border);border-radius:12px;padding:14px;margin-bottom:16px">
                <div style="font-size:13px;color:var(--text-muted);margin-bottom:10px">睡姿分布</div>`;
            for (const [position, duration] of positionEntries) {
                html += `<div style="display:flex;justify-content:space-between;padding:4px 0;font-size:14px">
                    <span>${sleepPositionLabels[position]}</span>
                    <span>${formatSleepDurationMinutes(duration)}</span>
                </div>`;
            }
            html += `</div>`;
        }

        // Session duration bar chart
        html += `<div style="margin-bottom:20px">
            <div style="font-weight:600;margin-bottom:12px;color:var(--text-secondary);font-size:13px;text-transform:uppercase;letter-spacing:0.5px">睡眠分布</div>
            <div style="position:relative;height:${barHeight}px;background:#f0f0f0;border-radius:6px;overflow:visible;">
                ${sessions.map((s, i) => {
                    const startHour = s.start.getHours() + s.start.getMinutes() / 60;
                    const durationMins = s.ongoing ? (now - s.start) / 60000 : s.durationMs / 60000;
                    const durationHours = durationMins / 60;
                    const leftPct = (startHour / 24) * 100;
                    const widthPct = Math.max((durationHours / 24) * 100, 1); // at least 1% width
                    const heightPct = (durationMins / maxDuration) * 100;
                    const barColor = durationMins < 30 ? '#ef4444' : durationMins < 60 ? '#ffb300' : '#22c55e';
                    const startStr = s.start.toLocaleTimeString('zh-CN', {hour:'2-digit', minute:'2-digit'});
                    return `<div style="position:absolute;bottom:0;left:${leftPct}%;width:${widthPct}%;height:${heightPct}%;background:${barColor};border-radius:3px 3px 0 0;min-height:4px;transition:height 0.3s ease;opacity:0.85" title="${startStr} ${durationMins.toFixed(0)}分钟"></div>`;
                }).join('')}
            </div>
            <div style="display:flex;justify-content:space-between;font-size:10px;color:var(--text-muted);margin-top:4px">
                <span>0</span><span>6</span><span>12</span><span>18</span><span>24</span>
            </div>
            <div style="display:flex;justify-content:center;gap:20px;margin-top:10px;font-size:11px">
                <span style="display:flex;align-items:center;gap:4px"><span style="width:10px;height:10px;background:#ef4444;border-radius:2px"></span> &lt;30分钟</span>
                <span style="display:flex;align-items:center;gap:4px"><span style="width:10px;height:10px;background:#ffb300;border-radius:2px"></span> 30分钟-1小时</span>
                <span style="display:flex;align-items:center;gap:4px"><span style="width:10px;height:10px;background:#22c55e;border-radius:2px"></span> ≥1小时</span>
            </div>
        </div>`;

        // Session list
        html += `<div style="margin-bottom:16px">
            <div style="font-weight:600;margin-bottom:12px;color:var(--text-secondary);font-size:13px;text-transform:uppercase;letter-spacing:0.5px">睡眠记录</div>
        </div>`;

        for (let i = sessions.length - 1; i >= 0; i--) {
            const s = sessions[i];
            const durationMins = Math.floor(s.durationMs / 60000);
            const durationText = formatSleepDurationMinutes(durationMins);
            const startStr = s.start.toLocaleTimeString('zh-CN', {hour:'2-digit', minute:'2-digit'});
            const endStr = s.ongoing ? '进行中' : s.end.toLocaleTimeString('zh-CN', {hour:'2-digit', minute:'2-digit'});
            const bgColor = i % 2 === 0 ? 'var(--bg-card)' : 'transparent';
            const positionText = s.sleepPosition ? ` · ${sleepPositionLabels[s.sleepPosition] || s.sleepPosition}` : '';

            html += `<div style="display:flex;align-items:center;padding:12px 0;border-bottom:1px solid var(--border);background:${bgColor};margin:0 -12px;padding-left:12px;padding-right:12px">
                <div style="width:8px;height:8px;border-radius:50%;background:var(--accent-sleep, #7c3aed);margin-right:12px;flex-shrink:0"></div>
                <div style="flex:1">
                    <div style="font-size:14px;font-weight:500">${startStr} → ${endStr}</div>
                    <div style="font-size:12px;color:var(--text-muted)">${durationText}${positionText}</div>
                </div>
                ${s.ongoing ? '<span style="background:var(--accent-sleep, #7c3aed);color:white;font-size:11px;padding:2px 8px;border-radius:10px">进行中</span>' : ''}
            </div>`;
        }

        body.innerHTML = html;
    }

    function renderMd(text) {
        if (!text) return '';
        const esc = t => t.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
        let html = esc(text);

        // Tables: convert each |cell| to a <span>cell</span>, wrap rows in divs
        // Step 1: split into lines, process tables line-by-line
        const lines = html.split('\n');
        const out = [];
        let inTable = false;
        let tableRows = [];
        for (let line of lines) {
            const cells = line.trim().split('|').filter(c => c.trim() && !/^-+$/.test(c.trim()));
            if (cells.length > 1) {
                inTable = true;
                tableRows.push(cells);
            } else {
                if (inTable && tableRows.length) {
                    out.push('<div style="overflow-x:auto;margin:8px 0">');
                    out.push('<table style="width:100%;border-collapse:collapse;font-size:13px">');
                    tableRows.forEach((cells, i) => {
                        const tag = i === 0 ? 'th' : 'td';
                        const rowStyle = i === 0 ? 'font-weight:600' : '';
                        out.push('<tr>');
                        cells.forEach(c => {
                            out.push(`<${tag} style="border:1px solid var(--border);padding:6px 10px;${rowStyle}">${c.trim()}</${tag}>`);
                        });
                        out.push('</tr>');
                    });
                    out.push('</table></div>');
                    tableRows = [];
                }
                inTable = false;
                out.push(line);
            }
        }
        if (inTable && tableRows.length) {
            out.push('<div style="overflow-x:auto;margin:8px 0">');
            out.push('<table style="width:100%;border-collapse:collapse;font-size:13px">');
            tableRows.forEach((cells, i) => {
                const tag = i === 0 ? 'th' : 'td';
                const rowStyle = i === 0 ? 'font-weight:600' : '';
                out.push('<tr>');
                cells.forEach(c => {
                    out.push(`<${tag} style="border:1px solid var(--border);padding:6px 10px;${rowStyle}">${c.trim()}</${tag}>`);
                });
                out.push('</tr>');
            });
            out.push('</table></div>');
        }
        html = out.join('<br>');

        // Headers, bold, italic, lists
        html = html
            .replace(/^### (.+)$/gm, '<br><b>$1</b>')
            .replace(/^## (.+)$/gm, '<br><b>$1</b>')
            .replace(/^# (.+)$/gm, '<br><b>$1</b>')
            .replace(/\*\*(.+?)\*\*/g, '<b>$1</b>')
            .replace(/\*(.+?)\*/g, '<i>$1</i>')
            .replace(/^- (.+)$/gm, '<br>• $1')
            .replace(/&lt;br&gt;/g, '<br>');
        return html;
    }

    async function doAiAnalysis() {
        const btn = document.getElementById('ai-analysis-btn');
        const resultDiv = document.getElementById('ai-analysis-result');
        const spinner = document.getElementById('ai-analysis-spinner');
        if (!btn || !resultDiv || !spinner) return;
        btn.disabled = true;
        btn.textContent = '🤖 分析中...';
        resultDiv.style.display = 'none';
        resultDiv.innerHTML = '';
        spinner.style.display = 'block';

        try {
            const res = await fetch('/api/ai-analysis', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    date: statsCalSelectedDate || getChinaDateString()
                })
            });
            const data = await res.json();
            spinner.style.display = 'none';
            if (data.success) {
                resultDiv.style.display = 'block';
                resultDiv.style.background = 'var(--bg-card)';
                resultDiv.style.border = '1px solid var(--border)';
                resultDiv.style.borderRadius = '12px';
                resultDiv.style.padding = '14px';
                resultDiv.style.lineHeight = '1.8';
                resultDiv.style.fontSize = '14px';
                resultDiv.style.color = 'var(--text-primary)';
                resultDiv.style.whiteSpace = 'pre-wrap';
                resultDiv.style.wordBreak = 'break-word';
                resultDiv.innerHTML = renderMd(data.analysis);
            } else {
                resultDiv.style.display = 'block';
                resultDiv.style.color = '#ef4444';
                resultDiv.style.fontSize = '13px';
                resultDiv.style.textAlign = 'center';
                resultDiv.style.background = 'transparent';
                resultDiv.style.border = 'none';
                resultDiv.style.borderRadius = '0';
                resultDiv.style.padding = '0';
                resultDiv.textContent = '分析失败：' + (data.error || '未知错误');
            }
        } catch(e) {
            spinner.style.display = 'none';
            resultDiv.style.display = 'block';
            resultDiv.style.color = '#ef4444';
            resultDiv.style.fontSize = '13px';
            resultDiv.style.textAlign = 'center';
            resultDiv.style.background = 'transparent';
            resultDiv.style.border = 'none';
            resultDiv.style.borderRadius = '0';
            resultDiv.style.padding = '0';
            resultDiv.textContent = '网络错误，请重试';
        }
        btn.textContent = '🤖 AI 智能分析';
        btn.disabled = false;
    }

    function closeModal(type) {
        const overlay = document.getElementById(`${type}-modal`);
        overlay.classList.remove('active');
        document.body.style.overflow = '';
        // Reset add forms (edit forms use different reset logic)
        if (!type.startsWith('edit-')) {
            const form = document.getElementById(`${type}-form`);
            if (form) form.reset();
            const options = document.querySelectorAll(`#${type}-type-options .form-option`);
            options.forEach((opt, i) => opt.classList.toggle('selected', i === 0));
            if (type === 'sleep') {
                resetSleepPositionSelection('sleep');
                toggleSleepPositionFields('sleep', 'awake');
            } else if (type === 'health') {
                toggleHealthFields('health', 'temperature');
            }
        }
    }

    function resetSleepPositionSelection(prefix) {
        const options = document.querySelectorAll(`#${prefix}-position-options .form-option`);
        options.forEach(opt => opt.classList.remove('selected'));
    }

    function toggleSleepPositionFields(prefix, sleepType) {
        const group = document.getElementById(`${prefix}-position-group`);
        if (!group) return;
        const isSleeping = sleepType === 'sleep';
        group.style.display = isSleeping ? '' : 'none';
        if (!isSleeping) {
            resetSleepPositionSelection(prefix);
        }
    }

    function toggleHealthFields(prefix, healthType) {
        const temperatureGroup = document.getElementById(`${prefix}-temperature-group`);
        const medicineGroup = document.getElementById(`${prefix}-medicine-group`);
        if (temperatureGroup) temperatureGroup.style.display = healthType === 'temperature' ? '' : 'none';
        if (medicineGroup) medicineGroup.style.display = healthType === 'medicine' ? '' : 'none';
    }

    async function openEditModal(type, id) {
        const record = records.find(r => r.id === id);
        if (!record) return;

        if (type === 'feed') {
            const modal = document.getElementById('edit-feed-modal');
            document.getElementById('edit-feed-id').value = id;
            document.getElementById('edit-feed-amount-input').value = record.amount || 100;
            document.getElementById('edit-feed-note').value = record.note || '';
            document.getElementById('edit-feed-original-time').value = record.time;
            document.getElementById('edit-feed-is-new-milk').checked = record.isNewMilk || false;
            const dt = parseLocalTime(record.time);
            document.getElementById('edit-feed-time').value =
                `${dt.getFullYear()}-${String(dt.getMonth()+1).padStart(2,'0')}-${String(dt.getDate()).padStart(2,'0')}T${String(dt.getHours()).padStart(2, '0')}:${String(dt.getMinutes()).padStart(2, '0')}`;
            modal.classList.add('active');
            document.body.style.overflow = 'hidden';
        } else if (type === 'diaper') {
            const modal = document.getElementById('edit-diaper-modal');
            document.getElementById('edit-diaper-id').value = id;
            document.getElementById('edit-diaper-note').value = record.note || '';
            const dt = parseLocalTime(record.time);
            document.getElementById('edit-diaper-time').value =
                `${dt.getFullYear()}-${String(dt.getMonth()+1).padStart(2,'0')}-${String(dt.getDate()).padStart(2,'0')}T${String(dt.getHours()).padStart(2, '0')}:${String(dt.getMinutes()).padStart(2, '0')}`;
            document.getElementById('edit-diaper-original-time').value = record.time;
            // Select correct diaper type option
            const opts = document.querySelectorAll('#edit-diaper-type-options .form-option');
            opts.forEach(o => {
                o.classList.toggle('selected', o.dataset.value === record.diaperType);
            });
            modal.classList.add('active');
            document.body.style.overflow = 'hidden';
        } else if (type === 'sleep') {
            const modal = document.getElementById('edit-sleep-modal');
            document.getElementById('edit-sleep-id').value = id;
            document.getElementById('edit-sleep-note').value = record.note || '';
            const dt = parseLocalTime(record.time);
            document.getElementById('edit-sleep-time').value =
                `${dt.getFullYear()}-${String(dt.getMonth()+1).padStart(2,'0')}-${String(dt.getDate()).padStart(2,'0')}T${String(dt.getHours()).padStart(2, '0')}:${String(dt.getMinutes()).padStart(2, '0')}`;
            document.getElementById('edit-sleep-original-time').value = record.time;
            // Select correct sleep type option
            const opts = document.querySelectorAll('#edit-sleep-type-options .form-option');
            opts.forEach(o => {
                o.classList.toggle('selected', o.dataset.value === record.sleepType);
            });
            toggleSleepPositionFields('edit-sleep', record.sleepType);
            const positionOpts = document.querySelectorAll('#edit-sleep-position-options .form-option');
            positionOpts.forEach(o => {
                o.classList.toggle('selected', o.dataset.value === record.sleepPosition);
            });
            modal.classList.add('active');
            document.body.style.overflow = 'hidden';
        } else if (type === 'supplement') {
            const modal = document.getElementById('edit-supplement-modal');
            document.getElementById('edit-supplement-id').value = id;
            document.getElementById('edit-supplement-note').value = record.note || '';
            const dt = parseLocalTime(record.time);
            document.getElementById('edit-supplement-time').value =
                `${dt.getFullYear()}-${String(dt.getMonth()+1).padStart(2,'0')}-${String(dt.getDate()).padStart(2,'0')}T${String(dt.getHours()).padStart(2, '0')}:${String(dt.getMinutes()).padStart(2, '0')}`;
            document.getElementById('edit-supplement-original-time').value = record.time;
            // Select correct supplement type option
            const opts = document.querySelectorAll('#edit-supplement-type-options .form-option');
            opts.forEach(o => {
                o.classList.toggle('selected', o.dataset.value === record.supplementType || o.dataset.legacyType === record.supplementType);
            });
            modal.classList.add('active');
            document.body.style.overflow = 'hidden';
        } else if (type === 'tummy') {
            const modal = document.getElementById('edit-tummy-modal');
            document.getElementById('edit-tummy-id').value = id;
            document.getElementById('edit-tummy-duration-input').value = record.duration || 1;
            document.getElementById('edit-tummy-note').value = record.note || '';
            const dt = parseLocalTime(record.time);
            document.getElementById('edit-tummy-time').value =
                `${dt.getFullYear()}-${String(dt.getMonth()+1).padStart(2,'0')}-${String(dt.getDate()).padStart(2,'0')}T${String(dt.getHours()).padStart(2, '0')}:${String(dt.getMinutes()).padStart(2, '0')}`;
            document.getElementById('edit-tummy-original-time').value = record.time;
            modal.classList.add('active');
            document.body.style.overflow = 'hidden';
        } else if (type === 'health') {
            const modal = document.getElementById('edit-health-modal');
            document.getElementById('edit-health-id').value = id;
            document.getElementById('edit-health-note').value = record.note || '';
            document.getElementById('edit-health-temperature').value = record.temperature || '';
            document.getElementById('edit-health-medicine-dose').value = record.medicineDose || '';
            const dt = parseLocalTime(record.time);
            document.getElementById('edit-health-time').value = `${dt.getFullYear()}-${String(dt.getMonth()+1).padStart(2,'0')}-${String(dt.getDate()).padStart(2,'0')}T${String(dt.getHours()).padStart(2,'0')}:${String(dt.getMinutes()).padStart(2, '0')}`;
            document.getElementById('edit-health-original-time').value = record.time;
            document.querySelectorAll('#edit-health-type-options .form-option').forEach(o => o.classList.toggle('selected', o.dataset.value === record.healthType));
            toggleHealthFields('edit-health', record.healthType);
            loadMedicineOptions(record.medicineName || '');
            modal.classList.add('active');
            document.body.style.overflow = 'hidden';
        }
    }

    function adjustEditAmount(delta) {
        const input = document.getElementById('edit-feed-amount-input');
        let val = parseInt(input.value) || 0;
        val = Math.max(0, val + delta);
        input.value = val;
    }

    function adjustEditTummyDuration(delta) {
        const input = document.getElementById('edit-tummy-duration-input');
        let val = parseInt(input.value, 10) || 1;
        val = Math.max(1, val + delta);
        input.value = val;
    }

    async function submitEditForm(type) {
        const id = document.getElementById(`edit-${type}-id`).value;
        const data = { type };

        if (type === 'feed') {
            data.amount = parseInt(document.getElementById('edit-feed-amount-input').value) || null;
            const originalTime = document.getElementById('edit-feed-original-time').value;
            const newTime = document.getElementById('edit-feed-time').value;
            data.time = mergeTimeToDate(originalTime, newTime);
            data.note = document.getElementById('edit-feed-note').value;
            data.isNewMilk = document.getElementById('edit-feed-is-new-milk').checked;
        } else if (type === 'diaper') {
            data.diaperType = getSelectedValue('edit-diaper-type');
            const originalTime = document.getElementById('edit-diaper-original-time').value;
            const newTime = document.getElementById('edit-diaper-time').value;
            data.time = mergeTimeToDate(originalTime, newTime);
            data.note = document.getElementById('edit-diaper-note').value;
        } else if (type === 'sleep') {
            data.sleepType = getSelectedValue('edit-sleep-type');
            if (data.sleepType === 'sleep') {
                data.sleepPosition = getSelectedValue('edit-sleep-position');
                if (!data.sleepPosition) {
                    showToast('请选择睡姿', '❌');
                    return;
                }
            } else {
                data.sleepPosition = null;
            }
            const originalTime = document.getElementById('edit-sleep-original-time').value;
            const newTime = document.getElementById('edit-sleep-time').value;
            data.time = mergeTimeToDate(originalTime, newTime);
            data.note = document.getElementById('edit-sleep-note').value;
        } else if (type === 'supplement') {
            data.supplementType = getSelectedValue('edit-supplement-type');
            const originalTime = document.getElementById('edit-supplement-original-time').value;
            const newTime = document.getElementById('edit-supplement-time').value;
            data.time = mergeTimeToDate(originalTime, newTime);
            data.note = document.getElementById('edit-supplement-note').value;
        } else if (type === 'tummy') {
            data.duration = parseInt(document.getElementById('edit-tummy-duration-input').value, 10) || 1;
            data.duration = Math.max(1, data.duration);
            const originalTime = document.getElementById('edit-tummy-original-time').value;
            const newTime = document.getElementById('edit-tummy-time').value;
            data.time = mergeTimeToDate(originalTime, newTime);
            data.note = document.getElementById('edit-tummy-note').value;
        } else if (type === 'health') {
            data.healthType = getSelectedValue('edit-health-type');
            data.time = `${document.getElementById('edit-health-time').value}:00+08:00`;
            data.note = document.getElementById('edit-health-note').value;
            if (data.healthType === 'temperature') {
                data.temperature = document.getElementById('edit-health-temperature').value;
                if (!data.temperature) { showToast('请填写体温', '❌'); return; }
            } else {
                data.medicineName = document.getElementById('edit-health-medicine-name').value;
                data.medicineDose = document.getElementById('edit-health-medicine-dose').value.trim();
                if (!data.medicineName) { showToast('请填写药名', '❌'); return; }
            }
        }

        function mergeTimeToDate(originalIso, newDateTime) {
            // newDateTime: "2026-04-01T15:45" (from datetime-local input)
            return `${newDateTime}:00+08:00`;
        }

        try {
            const response = await formReq('POST', `/api/records/${id}/update`, data);
            if (response.ok) {
                updateRecordsVersion(response);
                upsertLocalRecord(await response.json());
                await fetchRecords();
                closeModal(`edit-${type}`);
                showToast('修改已保存');
            } else {
                showToast('修改失败', '❌');
            }
        } catch (error) {
            console.error('Failed to update record:', error);
            showToast('修改失败', '❌');
        }
    }

    async function deleteRecordById(id) {
        if (!confirm('确定要删除这条记录吗？')) return;
        try {
            const response = await formReq('POST', `/api/records/${id}/delete`);
            if (response.ok) {
                updateRecordsVersion(response);
                removeLocalRecord(id);
                await fetchRecords();
                showToast('记录已删除');
            } else {
                showToast('删除失败', '❌');
            }
        } catch (error) {
            console.error('Failed to delete record:', error);
            showToast('删除失败', '❌');
        }
    }

    async function deleteRecord(type) {
        const id = document.getElementById(`edit-${type}-id`).value;
        if (!confirm('确定要删除这条记录吗？')) return;

        try {
            const response = await formReq('POST', `/api/records/${id}/delete`);
            if (response.ok) {
                updateRecordsVersion(response);
                removeLocalRecord(id);
                await fetchRecords();
                closeModal(`edit-${type}`);
                showToast('记录已删除');
            } else {
                showToast('删除失败', '❌');
            }
        } catch (error) {
            console.error('Failed to delete record:', error);
            showToast('删除失败', '❌');
        }
    }

    function selectOption(element, group) {
        const siblings = element.parentElement.querySelectorAll('.form-option');
        siblings.forEach(s => s.classList.remove('selected'));
        element.classList.add('selected');
    }

    function getSelectedValue(groupId) {
        const selected = document.querySelector(`#${groupId}-options .form-option.selected`);
        return selected ? selected.dataset.value : null;
    }

    function adjustAmount(delta) {
        const input = document.getElementById('feed-amount-input');
        let val = parseInt(input.value) || 0;
        val = Math.max(0, val + delta);
        input.value = val;
    }

    function adjustTummyDuration(delta) {
        const input = document.getElementById('tummy-duration-input');
        let val = parseInt(input.value, 10) || 1;
        val = Math.max(1, val + delta);
        input.value = val;
    }

    // Parse naive ISO timestamp (no timezone) as local CST time, return Date
    function parseLocalTime(isoStr) {
        // Handles both "2026-05-05T09:38:32" (naive) and "2026-05-05T09:38:32+08:00" (aware)
        if (!isoStr || isoStr.includes('+') || isoStr.endsWith('Z')) {
            return new Date(isoStr);
        }
        return new Date(`${isoStr}+08:00`);
    }

    function getLocalIsoNow() {
        const now = new Date();
        const y = now.getFullYear();
        const m = String(now.getMonth() + 1).padStart(2, '0');
        const d = String(now.getDate()).padStart(2, '0');
        const h = String(now.getHours()).padStart(2, '0');
        const min = String(now.getMinutes()).padStart(2, '0');
        const s = String(now.getSeconds()).padStart(2, '0');
        // Append +08:00 so JS new Date() interprets as CST, not UTC
        return `${y}-${m}-${d}T${h}:${min}:${s}+08:00`;
    }

    // Form submission
    async function submitForm(event, type) {
        event.preventDefault();
        const form = event.target;
        const formData = new FormData(form);

        const data = { type, time: getLocalIsoNow() };

        if (type === 'diaper') {
            data.diaperType = getSelectedValue('diaper-type');
            data.label = data.diaperType;
        } else if (type === 'feed') {
            data.feedType = 'bottle';
            data.label = '🍼 奶瓶';
            data.amount = formData.get('amount') || null;
            data.isNewMilk = form.querySelector('#feed-is-new-milk')?.checked || false;
        } else if (type === 'supplement') {
            data.supplementType = getSelectedValue('supplement-type');
            data.label = data.supplementType;
            if (selectedSupplementDoseSlotId) {
                data.doseSlotId = selectedSupplementDoseSlotId;
            }
        } else if (type === 'bath') {
            data.bathType = 'bath';
            data.label = '🛁 洗澡';
        } else if (type === 'health') {
            data.healthType = getSelectedValue('health-type');
            if (data.healthType === 'temperature') {
                data.temperature = formData.get('temperature');
                if (!data.temperature) {
                    showToast('请填写体温', '❌');
                    return;
                }
            } else {
                data.medicineName = formData.get('medicineName');
                data.medicineDose = formData.get('medicineDose')?.trim();
                if (!data.medicineName) {
                    showToast('请填写药名', '❌');
                    return;
                }
            }
        } else if (type === 'tummy') {
            data.duration = parseInt(formData.get('duration'), 10) || 1;
            data.label = '🧸 练趴';
        } else if (type === 'sleep') {
            data.sleepType = getSelectedValue('sleep-type');
            const sleepLabels = { awake: '👀 宝宝醒了', sleep: '🛏️ 宝宝睡了' };
            data.label = sleepLabels[data.sleepType] || sleepLabels['awake'];
            if (data.sleepType === 'sleep') {
                data.sleepPosition = getSelectedValue('sleep-position');
                if (!data.sleepPosition) {
                    showToast('请选择睡姿', '❌');
                    return;
                }
            }
        }

        const note = formData.get('note');
        if (note) data.note = note;

        closeModal(type);
        await createRecord(data);
    }

    // Render records
    let currentRecordFilter = 'feed';

    function setRecordFilter(filter) {
        currentRecordFilter = filter;
        document.querySelectorAll('.record-filter-btn').forEach(btn => {
            btn.classList.toggle('active', btn.dataset.filter === filter);
        });
        renderRecords();
    }

    function renderRecords() {
        const container = document.getElementById('records-list');

        if (records.length === 0) {
            container.innerHTML = `
                <div class="empty-state">
                    <div class="icon">👶</div>
                    <div class="title">暂无记录</div>
                    <div>点击上方按钮添加第一条记录</div>
                </div>
            `;
            return;
        }

        const filtered = currentRecordFilter === 'all'
            ? records
            : records.filter(r => r.type === currentRecordFilter);
        if (filtered.length === 0) {
            const labels = { feed: '喂奶', diaper: '尿布', supplement: '补剂', bath: '洗澡', health: '健康', sleep: '睡眠', tummy: '练趴' };
            const label = labels[currentRecordFilter] || '该类型';
            container.innerHTML = `
                <div class="empty-state">
                    <div class="icon">${recordsLoaded ? '📋' : '⏳'}</div>
                    <div class="title">${recordsLoaded ? `暂无${label}记录` : '正在加载记录...'}</div>
                </div>
            `;
            return;
        }
        container.innerHTML = filtered.slice(0, 10).map((record, index) => {
            const date = parseLocalTime(record.time);
            const timeStr = date.toLocaleTimeString('zh-CN', {
                hour: 'numeric',
                minute: '2-digit',
                hour12: true
            });
            const dateStr = date.toLocaleDateString('zh-CN', {
                month: 'short',
                day: 'numeric'
            });

            let icon, typeLabel, detail;
            if (record.type === 'diaper') {
                icon = getDiaperIcon(record.diaperType);
                typeLabel = '尿布';
                detail = getDiaperLabel(record.diaperType);
            } else if (record.type === 'feed') {
                icon = getFeedIcon(record.feedType);
                typeLabel = '喂奶';
                const amount = record.amount || '';
                if (record.isNewMilk) {
                    detail = `🆕${amount}ml`;
                } else {
                    detail = `${amount}ml`;
                }
            } else if (record.type === 'vitamin') {
                const suppLabelsV = {D3: '☀️ D3', AD: '🌟 AD', iron: '🔩 铁', probiotic: '🫙 益生菌'};
                detail = suppLabelsV[record.vitaminType] || getVitaminLabel(record.vitaminType);
                icon = detail.charAt(0);
                typeLabel = '补剂';
            } else if (record.type === 'probiotic') {
                detail = record.detail || '🫙 益生菌';
                icon = '🫙';
                typeLabel = '补剂';
            } else if (record.type === 'supplement') {
                const suppLabels = {D3: '☀️ D3', AD: '🌟 AD', iron: '🔩 铁', probiotic: '🫙 益生菌'};
                detail = record.detail || record.label || suppLabels[record.supplementType] || '💊 补剂';
                icon = detail.charAt(0);
                typeLabel = '补剂';
            } else if (record.type === 'bath') {
                icon = '🛁';
                typeLabel = '洗澡';
                detail = '🛁 洗澡';
            } else if (record.type === 'health') {
                if (record.healthType === 'temperature') {
                    icon = '🌡️';
                    typeLabel = '体温';
                    detail = `🌡️ 体温 ${record.temperature}°C`;
                } else {
                    icon = '💊';
                    typeLabel = '服药';
                    detail = `💊 服药 ${record.medicineName || ''}${record.medicineDose ? ` · ${record.medicineDose}` : ''}`;
                }
            } else if (record.type === 'tummy') {
                icon = '🧸';
                typeLabel = '练趴';
                detail = `🧸 练趴 ${record.duration || 1}分钟`;
            } else if (record.type === 'sleep') {
                icon = '🛏️';
                typeLabel = record.sleepType === 'sleep' ? '宝宝睡了' : '宝宝醒了';
                const sleepPositionLabels = { left: '左侧睡', right: '右侧睡', back: '平躺' };
                const positionText = record.sleepType === 'sleep' && record.sleepPosition ? ` · ${sleepPositionLabels[record.sleepPosition] || record.sleepPosition}` : '';
                detail = `${record.label || typeLabel}${positionText}`;
            }

            const canEdit = record.type === 'feed' || record.type === 'diaper' || record.type === 'sleep' || record.type === 'supplement' || record.type === 'tummy' || record.type === 'health';
            return `
                <div class="record-item-wrapper">
                    <div class="record-item ${record.type}" style="${canEdit ? 'cursor:pointer' : ''}" ${canEdit ? `onclick="openEditModal('${record.type}', '${record.id}')"` : `onclick="showToast('暂不支持修改', 'ℹ️')"`}>
                        <div class="record-content">
                            <div class="record-type" style="font-size:30px;font-weight:600">${detail}</div>
                            ${record.note ? `<div class="record-detail" style="font-style: italic; opacity: 0.7;">${record.note}</div>` : ''}
                        </div>
                        <div class="record-time">
                            <div class="time">${timeStr}</div>
                            <div class="date">${dateStr}</div>
                        </div>
                    </div>
                </div>
            `;
        }).join('');
    }

    function getDiaperIcon(type) {
        const icons = { wet: '💧', dirty: '🟤', both: '💫' };
        return icons[type] || '👶';
    }

    function getDiaperLabel(type) {
        const labels = { wet: '💧 尿', dirty: '🟤 粑粑', both: '💫 两者' };
        return labels[type] || '👶';
    }

    function getFeedIcon(type) {
        const icons = { left: '◀️', right: '▶️', both: '🔄', bottle: '🍼' };
        return icons[type] || '🍼';
    }

    function getVitaminIcon(type) {
        const icons = { D3: '☀️', AD: '🌟', probiotic: '🫙', iron: '🔩' };
        return icons[type] || '💊';
    }

    function getVitaminLabel(type) {
        const labels = { D3: '☀️ D3', AD: '🌟 AD', probiotic: '🫙 益生菌', iron: '🔩 铁' };
        return labels[type] || '💊';
    }

    // Update stats
    function updateStats() {
        updateFeverAnalysisVisibility();
        renderFeverMode();
        const recommendedSleepPosition = dashboardRecommendedSleepPosition;
        const sleepPositionShortLabels = { left: '左', right: '右' };
        const sleepPositionBadge = document.getElementById('sleep-position-badge');

        if (records.length > 0) {
            // Find last new milk and last diaper separately
            const newMilks = records.filter(r => r.type === 'feed' && r.isNewMilk);
            const diapers = records.filter(r => r.type === 'diaper');
            const now = new Date();

            if (newMilks.length > 0) {
                const lastNewMilk = newMilks[0];
                const diffMs = now - new Date(lastNewMilk.time);
                const diffMins = Math.floor(diffMs / 60000);
                let html;
                if (diffMins < 60) {
                    html = `<span class="time-num">${diffMins}</span>分钟前`;
                } else {
                    const hours = Math.floor(diffMins / 60);
                    const mins = diffMins % 60;
                    if (mins > 0) {
                        html = `<span class="time-num">${hours}</span>小时<span class="time-num">${mins}</span>分钟前`;
                    } else {
                        html = `<span class="time-num">${hours}</span>小时前`;
                    }
                }
                document.getElementById('time-since-feed').innerHTML = html;
            } else {
                document.getElementById('time-since-feed').innerHTML = '<span class="time-num">--</span>';
            }

            if (diapers.length > 0) {
                const lastDiaper = diapers[0];
                const diffMs = now - new Date(lastDiaper.time);
                const diffMins = Math.floor(diffMs / 60000);
                let html;
                if (diffMins < 60) {
                    html = `<span class="time-num">${diffMins}</span>分钟前`;
                } else {
                    const hours = Math.floor(diffMins / 60);
                    const mins = diffMins % 60;
                    if (mins > 0) {
                        html = `<span class="time-num">${hours}</span>小时<span class="time-num">${mins}</span>分钟前`;
                    } else {
                        html = `<span class="time-num">${hours}</span>小时前`;
                    }
                }
                document.getElementById('time-since-diaper').innerHTML = html;
            } else {
                document.getElementById('time-since-diaper').innerHTML = '<span class="time-num">--</span>';
            }

            // Calculate awake/sleep interval - use ALL records to handle cross-day sleep
            const openSleep = getCurrentOpenSleepStart();

            if (openSleep) {
                // Baby is sleeping, show sleep duration
                document.getElementById('awake-icon').textContent = '🛏️';
                if (sleepPositionBadge) {
                    sleepPositionBadge.style.display = 'none';
                    sleepPositionBadge.textContent = '';
                }
                const diffMs = now - openSleep;
                const diffMins = Math.floor(diffMs / 60000);
                if (diffMins < 60) {
                    document.getElementById('time-since-awake').innerHTML = `睡了<span class="time-num">${diffMins}</span>分钟`;
                } else {
                    const hours = Math.floor(diffMins / 60);
                    const mins = diffMins % 60;
                    if (mins > 0) {
                        document.getElementById('time-since-awake').innerHTML = `睡了<span class="time-num">${hours}</span>小时<span class="time-num">${mins}</span>分钟`;
                    } else {
                        document.getElementById('time-since-awake').innerHTML = `睡了<span class="time-num">${hours}</span>小时`;
                    }
                }
            } else {
                // Baby is awake, show awake duration
                document.getElementById('awake-icon').textContent = '👀';
                const awakeRecords = records.filter(r => r.type === 'sleep' && r.sleepType === 'awake');
                if (awakeRecords.length > 0) {
                    const lastAwake = awakeRecords[0];
                    const diffMs = now - new Date(lastAwake.time);
                    const diffMins = Math.floor(diffMs / 60000);
                    let awakeText;
                    if (diffMins < 60) {
                        awakeText = `醒了<span class="time-num">${diffMins}</span>分钟`;
                    } else {
                        const hours = Math.floor(diffMins / 60);
                        const mins = diffMins % 60;
                        if (mins > 0) {
                            awakeText = `醒了<span class="time-num">${hours}</span>小时<span class="time-num">${mins}</span>分钟`;
                        } else {
                            awakeText = `醒了<span class="time-num">${hours}</span>小时`;
                        }
                    }
                    const recommendedLabel = recommendedSleepPosition ? sleepPositionShortLabels[recommendedSleepPosition] : '';
                    if (sleepPositionBadge) {
                        sleepPositionBadge.textContent = recommendedLabel;
                        sleepPositionBadge.style.display = recommendedLabel ? 'inline-flex' : 'none';
                    }
                    document.getElementById('time-since-awake').innerHTML = awakeText;
                } else {
                    if (sleepPositionBadge) {
                        sleepPositionBadge.style.display = 'none';
                        sleepPositionBadge.textContent = '';
                    }
                    document.getElementById('time-since-awake').innerHTML = '<span class="time-num">--</span>';
                }
            }

            // Calculate total sleep today
            let totalSleepMs = 0;
            let openSleepForTotal = null;
            const sleepPairsForTotal = records
                .filter(r => r.type === 'sleep')
                .map(r => ({ time: parseLocalTime(r.time), type: r.sleepType }))
                .filter(r => !Number.isNaN(r.time.getTime()))
                .sort((a, b) => a.time - b.time);
            for (const p of sleepPairsForTotal) {
                if (p.type === 'sleep') {
                    openSleepForTotal = p.time;
                } else if (p.type === 'awake' && openSleepForTotal) {
                    totalSleepMs += p.time - openSleepForTotal;
                    openSleepForTotal = null;
                }
            }
            if (openSleepForTotal) {
                totalSleepMs += now - openSleepForTotal;
            }
        }
    }

    setInterval(updateVitaminReminder, 60000);

    // Close modal on overlay click
    document.querySelectorAll('.modal-overlay').forEach(overlay => {
        overlay.addEventListener('click', (e) => {
            if (e.target === overlay && overlay.dataset.closeOnBackdrop !== 'false') {
                const type = overlay.id.replace('-modal', '');
                closeModal(type);
            }
        });
    });

    function getDefaultSupplementType() {
        return dueSupplements.find(item => !isDueSupplementTaken(item))?.supplementId ||
            document.querySelector('#supplement-type-options .form-option')?.dataset.value || null;
    }

    function recordMatchesDueSupplement(record, supplement) {
        if (record.type !== 'supplement') return false;
        const sameSupplement = record.supplementId
            ? record.supplementId === supplement.supplementId
            : record.supplementType === supplement.supplementId ||
                (supplement.legacyRecordType && record.supplementType === supplement.legacyRecordType);
        return sameSupplement;
    }

    function getTodaySupplementRecords(supplement) {
        const today = getChinaDateString();
        return records
            .filter(record => record.time?.startsWith(today) && recordMatchesDueSupplement(record, supplement))
            .sort((a, b) => String(a.time).localeCompare(String(b.time)));
    }

    function getRecordForDueSupplement(supplement) {
        const matching = getTodaySupplementRecords(supplement);
        const exact = matching.find(record => record.doseSlotId === supplement.doseSlotId);
        if (exact) return exact;
        const unslotted = matching.filter(record => !record.doseSlotId);
        return unslotted[supplement.doseIndex - 1] || null;
    }

    function isDueSupplementTaken(supplement) {
        return Boolean(getRecordForDueSupplement(supplement));
    }

    function getSupplementProgressItems() {
        const groups = new Map();
        dueSupplements.forEach(item => {
            if (!groups.has(item.supplementId)) {
                groups.set(item.supplementId, {
                    supplementId: item.supplementId,
                    name: item.name,
                    icon: item.icon || '💊',
                    reminderMode: item.reminderMode,
                    total: 0,
                    taken: 0,
                    nextDose: null
                });
            }
            const group = groups.get(item.supplementId);
            group.total += 1;
            if (isDueSupplementTaken(item)) {
                group.taken += 1;
            } else if (!group.nextDose) {
                group.nextDose = item;
            }
        });
        return Array.from(groups.values()).map(group => ({
            ...group,
            completed: group.taken >= group.total,
            displayName: group.total === 1
                ? group.name
                : `${group.name}（${group.taken}/${group.total}）`
        }));
    }

    function getChinaDateString(date = new Date()) {
        const parts = new Intl.DateTimeFormat('en-CA', {
            timeZone: 'Asia/Shanghai',
            year: 'numeric',
            month: '2-digit',
            day: '2-digit'
        }).formatToParts(date);
        const values = Object.fromEntries(parts.map(part => [part.type, part.value]));
        return `${values.year}-${values.month}-${values.day}`;
    }

    function updateVitaminReminder() {
        const pending = getSupplementProgressItems()
            .filter(item => item.reminderMode !== 'none' && !item.completed)
            .map(item => item.displayName);
        const el = document.getElementById('supplement-reminder');
        if (pending.length === 0) {
            if (el) el.style.display = 'none';
        } else {
            if (el) {
                el.style.display = '';
                const title = el.querySelector('.vitamin-reminder-title');
                if (title) title.textContent = pending.join('、') + '还没吃';
            }
        }
    }

let medicineSettings = {medicines: []};

async function loadMedicineOptions(selectedMedicine = '') {
  try {
    const response = await fetch('/api/medicine-settings');
    medicineSettings = await response.json();
    ['health-medicine-name', 'edit-health-medicine-name'].forEach(id => {
      const select = document.getElementById(id);
      if (!select) return;
      const selected = selectedMedicine || select.value;
      select.innerHTML = '<option value="">请选择药品</option>';
      (medicineSettings.medicines || []).forEach(name => {
        const option = new Option(name, name, false, name === selected);
        select.add(option);
      });
      if (selected && !(medicineSettings.medicines || []).includes(selected)) {
        select.add(new Option(`历史药品：${selected}`, selected, false, true));
      }
    });
  } catch (error) {
    console.error('Failed to load medicine settings:', error);
  }
}

async function openMedicineSettings() {
  await loadMedicineOptions();
  renderMedicineList();
  document.getElementById('medicine-settings-modal').style.display = 'flex';
}

function closeMedicineSettings() {
  document.getElementById('medicine-settings-modal').style.display = 'none';
}

function renderMedicineList() {
  const container = document.getElementById('medicine-list');
  const medicines = medicineSettings.medicines || [];
  container.innerHTML = medicines.length
    ? medicines.map(name => `<div style="display:flex;justify-content:space-between;align-items:center;padding:10px 12px;background:#f8f8f8;border-radius:10px;margin-bottom:8px;color:#222;"><span>${escapeHtml(name)}</span><button type="button" data-name="${escapeHtml(name)}" onclick="removeMedicine(this.dataset.name)" style="border:none;background:none;color:#d44;font-size:18px;cursor:pointer;">×</button></div>`).join('')
    : '<div style="padding:14px;border:1px dashed #d0d7de;border-radius:10px;color:#666;text-align:center;">暂无药品，请先添加</div>';
}

function addMedicine() {
  const input = document.getElementById('medicine-name-input');
  const name = input.value.trim();
  if (!name) return;
  if (!(medicineSettings.medicines || []).includes(name)) {
    medicineSettings.medicines.push(name);
  }
  input.value = '';
  renderMedicineList();
}

function removeMedicine(name) {
  medicineSettings.medicines = (medicineSettings.medicines || []).filter(item => item !== name);
  renderMedicineList();
}

async function saveMedicineSettings() {
  const response = await fetch('/api/medicine-settings', {
    method: 'PUT',
    headers: {'Content-Type': 'application/json'},
    body: JSON.stringify(medicineSettings)
  });
  if (!response.ok) {
    showToast('药品配置保存失败', '❌');
    return;
  }
  await loadMedicineOptions();
  closeMedicineSettings();
  showToast('药品配置已保存');
}

let supplementSettings = {supplements: [], alternatingGroups: []};
const SUPPLEMENT_WEEKDAY_LABELS = ['周一', '周二', '周三', '周四', '周五', '周六', '周日'];

async function openSupplementSettings() {
  try {
    supplementSettings = await getJson('/api/supplement-settings');
    renderSupplementList();
    document.getElementById('supplement-settings-modal').style.display = 'flex';
  } catch (error) {
    showToast('补剂设置加载失败，请重试', '❌');
  }
}

function closeSupplementSettings() {
  document.getElementById('supplement-settings-modal').style.display = 'none';
}

let supplementEditorState = { mode: 'create', id: null };

function getRenderableSupplementItems() {
  const items = supplementSettings.supplements || [];
  const renderedGroups = new Set();
  return items.filter(item => {
    if (item.frequencyType !== 'alternating') return true;
    if (renderedGroups.has(item.groupId)) return false;
    renderedGroups.add(item.groupId);
    return true;
  });
}

function renderSupplementList() {
  const container = document.getElementById('supplement-list');
  const items = getRenderableSupplementItems();
  if (items.length === 0) {
    container.innerHTML = '<div style="padding:18px 12px;border:1px dashed #d0d7de;border-radius:12px;color:#666;text-align:center;">暂无补剂，点击下方添加</div>';
    return;
  }
  container.innerHTML = items.map(s => `
    <div style="background:white;border:1px solid #e0e0e0;border-radius:12px;padding:16px;margin-bottom:12px;box-shadow:0 1px 4px rgba(0,0,0,0.08);">
      <div style="display:flex;justify-content:space-between;align-items:flex-start;gap:12px;flex-wrap:wrap;">
        <div style="min-width:0;">
          <div style="font-weight:600;font-size:16px;color:#000;">${getSupplementDisplayName(s)}</div>
          <div style="color:#000;font-size:14px;font-weight:500;margin-top:4px;">${getSupplementFrequencySummary(s)}</div>
          <div style="color:#666;font-size:13px;margin-top:4px;">${getSupplementIntakeSummary(s)}</div>
        </div>
        <div style="display:flex;align-items:center;gap:8px;flex-shrink:0;">
          <span style="background:${getFrequencyColor(s.frequencyType)};color:white;padding:4px 12px;border-radius:20px;font-size:13px;font-weight:500;">${getFrequencyLabel(s.frequencyType)}</span>
          <button onclick="editSupplement('${s.id}')" style="background:none;border:none;cursor:pointer;color:#666;padding:4px;">✏️</button>
          <button onclick="deleteSupplement('${s.id}')" style="background:none;border:none;cursor:pointer;color:#FF6B6B;padding:4px;">🗑️</button>
        </div>
      </div>
      ${renderSupplementSwitches(s)}
    </div>
  `).join('');
}

function renderSupplementSwitches(supplement) {
  const members = supplement.frequencyType === 'alternating'
    ? getAlternatingGroupMembers(supplement.groupId)
    : [supplement];
  return `<div class="supplement-switch-list">${members.map(member => `
    <label class="supplement-switch-row">
      <span class="supplement-switch-description">
        <span class="supplement-switch-name">${escapeHtml(member.name)}</span>
        <span class="supplement-switch-status">${member.enabled === false ? '已暂停 · 不计入待办和提醒' : '已启用 · 按原计划安排'}</span>
      </span>
      <span class="supplement-switch-control">
        <input type="checkbox" role="switch" aria-label="${escapeHtml(member.name)}启用" data-supplement-id="${escapeHtml(member.id)}" ${member.enabled === false ? '' : 'checked'} onchange="toggleSupplementEnabled(this)">
        <span class="supplement-switch-track" aria-hidden="true"></span>
      </span>
    </label>
  `).join('')}</div>`;
}

function toggleSupplementEnabled(input) {
  const supplement = supplementSettings.supplements.find(item => item.id === input.dataset.supplementId);
  if (!supplement) return;
  supplement.enabled = input.checked;
  input.closest('.supplement-switch-row').querySelector('.supplement-switch-status').textContent = input.checked
    ? '已启用 · 按原计划安排'
    : '已暂停 · 不计入待办和提醒';
}

function getFrequencyLabel(type) {
  const labels = {
    everyNDays: '按天',
    weeklyTimes: '按周',
    alternating: '交替食用',
    daily: '每天吃',
    everyOtherDay: '隔天吃'
  };
  return labels[type] || type;
}

function getSupplementIntakePlan(supp) {
  const raw = supp?.intakePlan || {};
  const dailyCount = Math.min(4, Math.max(1, parseInt(raw.dailyCount, 10) || 1));
  const reminderMode = ['none', 'checklist', 'timed'].includes(raw.reminderMode) ? raw.reminderMode : 'checklist';
  const slots = Array.isArray(raw.slots) ? raw.slots : [];
  return { dailyCount, reminderMode, slots };
}

function getSupplementIntakeSummary(supp) {
  const plan = getSupplementIntakePlan(supp);
  if (plan.reminderMode === 'timed') {
    return `每日${plan.dailyCount}次 · 定时提醒：${plan.slots.map(slot => slot.time).filter(Boolean).join('、')}`;
  }
  return `每日${plan.dailyCount}次 · ${plan.reminderMode === 'none' ? '不提醒' : '首页待办'}`;
}

function getFrequencyColor(type) {
  const colors = {
    everyNDays: '#4A90D9',
    weeklyTimes: '#27AE60',
    alternating: '#9B59B6',
    daily: '#4A90D9',
    everyOtherDay: '#27AE60'
  };
  return colors[type] || '#999';
}

function getSupplementFrequencySummary(supp) {
  if (supp.frequencyType === 'everyNDays' || supp.frequencyType === 'daily' || supp.frequencyType === 'everyOtherDay') {
    const days = supp.intervalDays || (supp.frequencyType === 'everyOtherDay' ? 2 : 1);
    return formatEveryNDaysSummary(days);
  }
  if (supp.frequencyType === 'weeklyTimes') {
    const customDays = normalizeCustomDays(supp.customDays);
    if (customDays.length > 0) {
      return formatWeeklyDaysSummary(customDays);
    }
    return formatWeeklyDaysSummary(getDerivedWeeklyDays(supp));
  }
  if (supp.frequencyType === 'alternating') {
    const groupMembers = (supplementSettings.supplements || [])
      .filter(s => s.groupId === supp.groupId)
      .sort((a, b) => (a.alternatingOrder || 0) - (b.alternatingOrder || 0))
      .map(s => s.name);
    return `${joinWithHe(groupMembers)}交替吃`;
  }
  return getFrequencyLabel(supp.frequencyType);
}

function getSupplementDisplayName(supp) {
  if (supp.frequencyType !== 'alternating') return supp.name;
  const groupMembers = getAlternatingGroupMembers(supp.groupId).map(item => item.name);
  return joinWithHe(groupMembers);
}

function formatEveryNDaysSummary(days) {
  const normalizedDays = Math.max(1, parseInt(days, 10) || 1);
  if (normalizedDays === 1) return '每天';
  return `每${numberToChinese(normalizedDays)}天`;
}

function normalizeCustomDays(days) {
  return Array.from(new Set((days || [])
    .map(day => parseInt(day, 10))
    .filter(day => Number.isInteger(day) && day >= 0 && day <= 6)))
    .sort((a, b) => a - b);
}

function formatWeeklyDaysSummary(days) {
  const labels = normalizeCustomDays(days).map(day => SUPPLEMENT_WEEKDAY_LABELS[day]);
  if (labels.length === 0) return '每周';
  if (labels.length === 1) return `每${labels[0]}`;
  return `每${joinWithHe(labels)}`;
}

function joinWithHe(items) {
  if (!items || items.length === 0) return '';
  if (items.length === 1) return items[0];
  if (items.length === 2) return `${items[0]}和${items[1]}`;
  return `${items.slice(0, -1).join('、')}和${items[items.length - 1]}`;
}

function numberToChinese(num) {
  const digits = ['零', '一', '二', '三', '四', '五', '六', '七', '八', '九'];
  if (num <= 10) {
    return ['零', '一', '两', '三', '四', '五', '六', '七', '八', '九', '十'][num];
  }
  if (num < 20) return `十${digits[num % 10]}`;
  if (num < 100) {
    const tens = Math.floor(num / 10);
    const ones = num % 10;
    return `${digits[tens]}十${ones ? digits[ones] : ''}`;
  }
  return String(num);
}

function getDerivedWeeklyDays(supp) {
  const timesPerWeek = Math.min(7, Math.max(1, parseInt(supp.timesPerWeek, 10) || 1));
  const offsets = Array.from(new Set(Array.from({ length: timesPerWeek }, (_, i) => Math.floor((i * 7) / timesPerWeek)))).sort((a, b) => a - b);
  const startDate = supp.startDate || getChinaDateString();
  const start = new Date(`${startDate}T00:00:00`);
  const startWeekday = Number.isNaN(start.getTime()) ? 0 : ((start.getDay() + 6) % 7);
  return offsets.map(offset => (startWeekday + offset) % 7).sort((a, b) => a - b);
}

function setWeeklyDaySelection(days) {
  const selected = new Set(normalizeCustomDays(days));
  document.querySelectorAll('.supplement-weekday-cb').forEach(cb => {
    cb.checked = selected.has(parseInt(cb.value, 10));
  });
}

function getAlternatingGroupMembers(groupId) {
  return (supplementSettings.supplements || [])
    .filter(s => s.frequencyType === 'alternating' && s.groupId === groupId)
    .sort((a, b) => {
      const orderDiff = (a.alternatingOrder || 0) - (b.alternatingOrder || 0);
      return orderDiff || a.name.localeCompare(b.name, 'zh-Hans-CN');
    });
}

function renderAlternatingSupplementRows(items = []) {
  const container = document.getElementById('supplement-alternating-list');
  const rows = items.length > 0 ? items : [{ name: '', alternatingOrder: 1 }];
  container.innerHTML = rows.map((item, index) => `
    <div class="supplement-alternating-row" data-supplement-id="${escapeHtml(item.id || '')}" style="display:grid;grid-template-columns:minmax(0,1fr) 96px 40px;gap:10px;align-items:end;margin-bottom:10px;">
      <div style="display:flex;flex-direction:column;gap:6px;">
        <label style="font-size:13px;color:#666;">补剂名称 ${index + 1}</label>
        <input class="supplement-alternating-name" type="text" value="${escapeHtml(item.name || '')}" placeholder="例如：D3" style="padding:12px 14px;border:1px solid #d0d7de;border-radius:10px;font-size:15px;">
      </div>
      <div style="display:flex;flex-direction:column;gap:6px;">
        <label style="font-size:13px;color:#666;">序号</label>
        <input class="supplement-alternating-order" type="number" min="1" step="1" value="${Math.max(1, parseInt(item.alternatingOrder, 10) || index + 1)}" style="padding:12px 14px;border:1px solid #d0d7de;border-radius:10px;font-size:15px;">
      </div>
      <button type="button" onclick="removeAlternatingSupplementRow(${index})" style="height:44px;border:none;border-radius:10px;background:#fff1f1;color:#d44;cursor:pointer;font-size:18px;">-</button>
    </div>
  `).join('');
}

function addAlternatingSupplementRow() {
  const items = getAlternatingSupplementFormItems();
  items.push({
    name: '',
    alternatingOrder: items.length + 1
  });
  renderAlternatingSupplementRows(items);
}

function removeAlternatingSupplementRow(index) {
  const items = getAlternatingSupplementFormItems();
  if (items.length <= 1) {
    renderAlternatingSupplementRows([{ name: '', alternatingOrder: 1 }]);
    return;
  }
  items.splice(index, 1);
  renderAlternatingSupplementRows(items);
}

function getAlternatingSupplementFormItems() {
  return Array.from(document.querySelectorAll('.supplement-alternating-row')).map((row, index) => ({
    id: row.dataset.supplementId || null,
    name: row.querySelector('.supplement-alternating-name')?.value?.trim() || '',
    alternatingOrder: Math.max(1, parseInt(row.querySelector('.supplement-alternating-order')?.value, 10) || index + 1)
  }));
}

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function openSupplementEditor(mode, id = null) {
  supplementEditorState = { mode, id };
  const editor = document.getElementById('supplement-editor-modal');
  const title = document.getElementById('supplement-editor-title');
  const submit = document.getElementById('supplement-editor-submit');
  const form = document.getElementById('supplement-editor-form');
  form.reset();

  const supp = id ? supplementSettings.supplements.find(s => s.id === id) : null;
  const alternatingMembers = supp?.frequencyType === 'alternating'
    ? getAlternatingGroupMembers(supp.groupId)
    : [];
  const intakePlan = getSupplementIntakePlan(supp || alternatingMembers[0]);
  title.textContent = mode === 'edit' ? '修改补剂' : '添加补剂';
  submit.textContent = mode === 'edit' ? '保存修改' : '添加补剂';

  document.getElementById('supplement-name-input').value = supp?.name || '';
  document.getElementById('supplement-frequency-type').value = normalizeFrequencyTypeForEditor(supp?.frequencyType) || 'everyNDays';
  document.getElementById('supplement-interval-days').value = supp?.intervalDays || (supp?.frequencyType === 'everyOtherDay' ? 2 : 1);
  setWeeklyDaySelection(supp?.customDays || getDerivedWeeklyDays(supp || { timesPerWeek: 3, startDate: getChinaDateString() }));
  document.getElementById('supplement-start-date').value = supp?.startDate || getChinaDateString();
  document.getElementById('supplement-daily-count').value = intakePlan.dailyCount;
  document.getElementById('supplement-reminder-mode').value = intakePlan.reminderMode;
  renderSupplementTimedSlots(intakePlan.slots, intakePlan.dailyCount);
  renderAlternatingSupplementRows(alternatingMembers);

  updateSupplementFrequencyFields();
  updateSupplementIntakePlanFields();
  editor.style.display = 'flex';
}

function closeSupplementEditor() {
  document.getElementById('supplement-editor-modal').style.display = 'none';
}

function normalizeFrequencyTypeForEditor(type) {
  if (type === 'daily' || type === 'everyOtherDay') return 'everyNDays';
  return type || 'everyNDays';
}

function updateSupplementFrequencyFields() {
  const type = document.getElementById('supplement-frequency-type').value;
  const nameField = document.getElementById('supplement-name-field');
  const nameInput = document.getElementById('supplement-name-input');
  nameField.style.display = type === 'alternating' ? 'none' : 'flex';
  nameInput.required = type !== 'alternating';
  document.getElementById('supplement-frequency-every-n-days').style.display = type === 'everyNDays' ? 'block' : 'none';
  document.getElementById('supplement-frequency-weekly-times').style.display = type === 'weeklyTimes' ? 'block' : 'none';
  document.getElementById('supplement-frequency-alternating').style.display = type === 'alternating' ? 'block' : 'none';
}

function getDefaultTimedSlot(index) {
  const defaults = ['08:00', '12:00', '18:00', '21:00'];
  return defaults[index] || '08:00';
}

function renderSupplementTimedSlots(slots = [], count = null) {
  const container = document.getElementById('supplement-timed-slots');
  const dailyCount = count || Math.min(4, Math.max(1, parseInt(document.getElementById('supplement-daily-count').value, 10) || 1));
  container.innerHTML = Array.from({ length: dailyCount }, (_, index) => {
    const slot = slots[index] || {};
    return `<div class="supplement-timed-slot" data-slot-id="${escapeHtml(slot.id || `slot_${index + 1}`)}" style="display:grid;grid-template-columns:minmax(0,1fr) 108px;gap:10px;margin-bottom:10px;">
      <input class="supplement-slot-label" type="text" value="${escapeHtml(slot.label || `第${index + 1}次`)}" aria-label="第${index + 1}次名称" style="padding:10px 12px;border:1px solid #d0d7de;border-radius:8px;font-size:14px;">
      <input class="supplement-slot-time" type="time" value="${escapeHtml(slot.time || getDefaultTimedSlot(index))}" aria-label="第${index + 1}次时间" style="padding:10px 12px;border:1px solid #d0d7de;border-radius:8px;font-size:14px;">
    </div>`;
  }).join('');
}

function updateSupplementIntakePlanFields() {
  const reminderMode = document.getElementById('supplement-reminder-mode').value;
  const timedFields = document.getElementById('supplement-timed-fields');
  timedFields.style.display = reminderMode === 'timed' ? 'block' : 'none';
  if (reminderMode === 'timed') {
    const currentSlots = Array.from(document.querySelectorAll('.supplement-timed-slot')).map((row, index) => ({
      id: row.dataset.slotId || `slot_${index + 1}`,
      label: row.querySelector('.supplement-slot-label')?.value || '',
      time: row.querySelector('.supplement-slot-time')?.value || ''
    }));
    renderSupplementTimedSlots(currentSlots);
  }
}

function getSupplementIntakePlanFromEditor() {
  const dailyCount = Math.min(4, Math.max(1, parseInt(document.getElementById('supplement-daily-count').value, 10) || 1));
  const reminderMode = document.getElementById('supplement-reminder-mode').value;
  const plan = { dailyCount, reminderMode };
  if (reminderMode === 'timed') {
    plan.slots = Array.from(document.querySelectorAll('.supplement-timed-slot')).map((row, index) => ({
      id: row.dataset.slotId || `slot_${index + 1}`,
      label: row.querySelector('.supplement-slot-label').value.trim() || `第${index + 1}次`,
      time: row.querySelector('.supplement-slot-time').value
    }));
    if (plan.slots.length !== dailyCount || plan.slots.some(slot => !slot.time)) {
      return null;
    }
  }
  return plan;
}

function addSupplement() {
  openSupplementEditor('create');
}

function editSupplement(id) {
  openSupplementEditor('edit', id);
}

function submitSupplementEditor(event) {
  event.preventDefault();
  const frequencyType = document.getElementById('supplement-frequency-type').value;
  const startDate = document.getElementById('supplement-start-date').value || getChinaDateString();
  const intakePlan = getSupplementIntakePlanFromEditor();
  if (!intakePlan) {
    alert('请为每日每一次服用设置提醒时间');
    return;
  }
  const isEdit = supplementEditorState.mode === 'edit';
  const existing = isEdit ? supplementSettings.supplements.find(s => s.id === supplementEditorState.id) : null;
  if (frequencyType === 'alternating') {
    const items = getAlternatingSupplementFormItems()
      .filter(item => item.name)
      .sort((a, b) => a.alternatingOrder - b.alternatingOrder || a.name.localeCompare(b.name, 'zh-Hans-CN'));
    if (items.length === 0) {
      alert('请至少添加一个补剂名称');
      return;
    }
    const groupId = existing?.groupId || `group_${Date.now()}`;
    const retained = (supplementSettings.supplements || []).filter(item => {
      if (!isEdit) return true;
      return !(item.frequencyType === 'alternating' && item.groupId === existing?.groupId);
    });
    const existingMembers = existing?.frequencyType === 'alternating' ? getAlternatingGroupMembers(existing.groupId) : [];
    const alternatingSupplements = items.map((item, index) => ({
      id: existingMembers.find(member => member.id === item.id)?.id || `supp_${Date.now()}_${index}`,
      name: item.name,
      icon: '💊',
      enabled: (existing?.frequencyType === 'alternating'
        ? existingMembers.find(member => member.id === item.id)?.enabled
        : existing?.enabled) !== false,
      frequencyType: 'alternating',
      startDate,
      groupId,
      alternatingOrder: item.alternatingOrder,
      intakePlan
    }));
    supplementSettings.supplements = [...retained, ...alternatingSupplements];
  } else {
    const name = document.getElementById('supplement-name-input').value.trim();
    if (!name) return;
    const supp = {
      id: existing?.id || `supp_${Date.now()}`,
      name,
      icon: existing?.icon || '💊',
      frequencyType,
      startDate,
      intakePlan
    };

    if (frequencyType === 'everyNDays') {
      supp.intervalDays = Math.max(1, parseInt(document.getElementById('supplement-interval-days').value, 10) || 1);
    } else if (frequencyType === 'weeklyTimes') {
      supp.customDays = normalizeCustomDays(Array.from(document.querySelectorAll('.supplement-weekday-cb:checked')).map(cb => cb.value));
      if (supp.customDays.length === 0) {
        alert('请选择至少一个日期');
        return;
      }
      supp.timesPerWeek = supp.customDays.length;
    }

    if (isEdit) {
      supplementSettings.supplements = supplementSettings.supplements.map(item =>
        item.id === supplementEditorState.id ? { ...item, ...supp } : item
      );
    } else {
      supplementSettings.supplements.push(supp);
    }
  }

  closeSupplementEditor();
  renderSupplementList();
}

function deleteSupplement(id) {
  const target = supplementSettings.supplements.find(s => s.id === id);
  if (target?.frequencyType === 'alternating') {
    supplementSettings.supplements = supplementSettings.supplements.filter(s => !(s.frequencyType === 'alternating' && s.groupId === target.groupId));
  } else {
    supplementSettings.supplements = supplementSettings.supplements.filter(s => s.id !== id);
  }
  renderSupplementList();
}

async function saveSupplementSettings() {
  const button = document.getElementById('supplement-settings-save');
  if (button.disabled) return;
  button.disabled = true;
  button.textContent = '保存中...';
  try {
    const response = await fetch('/api/supplement-settings', {
      method: 'PUT',
      headers: {'Content-Type': 'application/json'},
      body: JSON.stringify(supplementSettings)
    });
    if (!response.ok || !(await response.json()).success) throw new Error('Save failed');
    closeSupplementSettings();
    location.reload();
  } catch (error) {
    showToast('补剂设置保存失败，请重试', '❌');
  } finally {
    button.disabled = false;
    button.textContent = '保存';
  }
}
