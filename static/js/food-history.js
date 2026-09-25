/* 辅食记录页：用共享日期组件替换原生 date 输入，选中后同步隐藏 input 触发既有加载逻辑 */
(() => {
    const hidden = document.getElementById('food-intake-history-date');
    const mount = document.getElementById('food-history-date-picker');
    if (!hidden || !mount || !window.createDatePicker) return;
    if (!hidden.value) hidden.value = hidden.max || '';
    window.createDatePicker({
        mount,
        value: hidden.value,
        max: hidden.max || null,
        hiddenInput: hidden
    });
})();
