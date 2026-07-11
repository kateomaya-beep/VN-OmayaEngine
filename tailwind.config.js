/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        // CSS-переменные (см. index.css) — переключаются через [data-theme] на <html>,
        // так весь существующий bg-ink/bg-panel/bg-panel2/text-* реагирует на тему
        // без переписывания классов по всем компонентам.
        ink: 'rgb(var(--nf-ink) / <alpha-value>)',
        panel: 'rgb(var(--nf-panel) / <alpha-value>)',
        panel2: 'rgb(var(--nf-panel2) / <alpha-value>)',
        accent: '#e0578b',
        accent2: '#7c5cff',
      },
      fontFamily: {
        sans: ['Inter', 'system-ui', 'sans-serif'],
      },
    },
  },
  plugins: [],
};
