/* Chart.js wrapper — 다크 팔레트 통일 */
(function () {
  const palette = {
    primary: '#0EA5E9',
    accent:  '#8B5CF6',
    success: '#10B981',
    warning: '#F59E0B',
    danger:  '#EF4444',
    grid:    'rgba(255,255,255,0.06)',
    text:    'rgba(229,231,235,0.72)'
  };

  function defaults() {
    if (!window.Chart) return;
    Chart.defaults.color = palette.text;
    Chart.defaults.borderColor = palette.grid;
    Chart.defaults.font.family = "'Inter','Noto Sans KR',sans-serif";
  }

  function ensureCtx(target) {
    const el = typeof target === 'string' ? document.getElementById(target) : target;
    if (!el) throw new Error('Canvas not found');
    return el.getContext('2d');
  }

  window.Charts = {
    palette,

    donut(target, { labels, values, colors }) {
      defaults();
      const ctx = ensureCtx(target);
      return new Chart(ctx, {
        type: 'doughnut',
        data: {
          labels,
          datasets: [{
            data: values,
            backgroundColor: colors || [palette.primary, palette.accent, palette.success, palette.warning, palette.danger],
            borderColor: 'rgba(11,18,32,0.8)',
            borderWidth: 2
          }]
        },
        options: {
          responsive: true, maintainAspectRatio: false,
          cutout: '65%',
          plugins: { legend: { position: 'bottom', labels: { boxWidth: 12, padding: 12 } } }
        }
      });
    },

    bar(target, { labels, values, label, color }) {
      defaults();
      const ctx = ensureCtx(target);
      const c = color || palette.primary;
      const grad = ctx.createLinearGradient(0, 0, 0, 320);
      grad.addColorStop(0, c);
      grad.addColorStop(1, c + '33');
      return new Chart(ctx, {
        type: 'bar',
        data: {
          labels,
          datasets: [{
            label: label || '',
            data: values,
            backgroundColor: grad,
            borderColor: c,
            borderWidth: 1,
            borderRadius: 6
          }]
        },
        options: {
          responsive: true, maintainAspectRatio: false,
          plugins: { legend: { display: !!label } },
          scales: {
            x: { grid: { display: false } },
            y: { grid: { color: palette.grid }, beginAtZero: true }
          }
        }
      });
    },

    line(target, { labels, datasets }) {
      defaults();
      const ctx = ensureCtx(target);
      const colors = [palette.primary, palette.accent, palette.success];
      return new Chart(ctx, {
        type: 'line',
        data: {
          labels,
          datasets: datasets.map((d, i) => {
            const c = d.color || colors[i % colors.length];
            return {
              label: d.label,
              data: d.values,
              borderColor: c,
              backgroundColor: c + '22',
              tension: 0.35,
              fill: true,
              pointRadius: 3,
              pointBackgroundColor: c
            };
          })
        },
        options: {
          responsive: true, maintainAspectRatio: false,
          plugins: { legend: { position: 'top' } },
          scales: {
            x: { grid: { color: palette.grid } },
            y: { grid: { color: palette.grid } }
          }
        }
      });
    },

    /**
     * 성장 곡선 차트 — 신장/하악골 길이 + peak velocity 마커.
     * data: { ages:[], height:[], mandible:[], peakAge: number }
     */
    growthCurve(target, data) {
      defaults();
      const ctx = ensureCtx(target);
      return new Chart(ctx, {
        type: 'line',
        data: {
          labels: data.ages,
          datasets: [
            {
              label: '신장 (cm)',
              data: data.height,
              yAxisID: 'y1',
              borderColor: palette.primary,
              backgroundColor: palette.primary + '22',
              tension: 0.4, fill: true
            },
            {
              label: '하악골 길이 (mm)',
              data: data.mandible,
              yAxisID: 'y2',
              borderColor: palette.accent,
              backgroundColor: palette.accent + '22',
              tension: 0.4, fill: false,
              borderDash: [4, 4]
            }
          ]
        },
        options: {
          responsive: true, maintainAspectRatio: false,
          plugins: {
            legend: { position: 'top' },
            annotation: data.peakAge ? {
              annotations: {
                peak: {
                  type: 'line',
                  xMin: data.peakAge,
                  xMax: data.peakAge,
                  borderColor: palette.warning,
                  borderWidth: 2,
                  borderDash: [6, 4],
                  label: { content: 'Peak Velocity', display: true, position: 'start', color: palette.warning }
                }
              }
            } : {}
          },
          scales: {
            x: { grid: { color: palette.grid }, title: { display: true, text: '나이 (세)' } },
            y1: { position: 'left', grid: { color: palette.grid }, title: { display: true, text: '신장 (cm)', color: palette.primary } },
            y2: { position: 'right', grid: { display: false }, title: { display: true, text: '하악 (mm)', color: palette.accent } }
          }
        }
      });
    }
  };
})();
