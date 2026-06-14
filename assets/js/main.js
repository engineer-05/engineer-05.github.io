/**
 * patience's blog — 实时时钟 + 文章分类筛选
 */
(function() {
    'use strict';

    // ============================================================
    // 1. 实时时钟
    // ============================================================
    function updateClock() {
        var now = new Date();
        var h = now.getHours().toString().padStart(2, '0');
        var m = now.getMinutes().toString().padStart(2, '0');
        var s = now.getSeconds().toString().padStart(2, '0');

        var timeEl = document.getElementById('clock-time');
        var dateEl = document.getElementById('clock-date');

        if (timeEl) timeEl.textContent = h + ':' + m + ':' + s;

        if (dateEl) {
            var weekdays = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];
            var y = now.getFullYear();
            var mo = now.getMonth() + 1;
            var d = now.getDate();
            var w = weekdays[now.getDay()];
            dateEl.textContent = y + '年' + mo + '月' + d + '日 ' + w;
        }
    }

    updateClock();
    setInterval(updateClock, 1000);

    // ============================================================
    // 2. 分类 Tab 筛选
    // ============================================================
    var tabBtns = document.querySelectorAll('.tab-btn');
    var postItems = document.querySelectorAll('.post-item');

    if (!tabBtns.length || !postItems.length) return;

    tabBtns.forEach(function(btn) {
        btn.addEventListener('click', function() {
            // 更新 active 状态
            tabBtns.forEach(function(b) { b.classList.remove('active'); });
            btn.classList.add('active');

            var category = btn.getAttribute('data-category');

            postItems.forEach(function(item, index) {
                var cats = item.getAttribute('data-categories') || '';

                if (category === 'all' || cats.indexOf(category) !== -1) {
                    item.style.display = '';
                    // 错开动画
                    item.style.animation = 'fadeIn 0.4s ease forwards ' + (index * 0.05) + 's';
                } else {
                    item.style.display = 'none';
                }
            });
        });
    });
})();
