/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{js,jsx}'],
  theme: {
    extend: {
      colors: {
        ink: '#05050B',
        panel: '#0B0B14',
        panel2: '#11111B',
        line: 'rgba(255,255,255,0.10)',
        lime: '#C7F73C',
        magenta: '#FF3F8B',
        cyan: '#4EE2EC',
        gold: '#FFCC2F',
        violet: '#9B6BFF',
        coral: '#FF7A4D',
      },
      fontFamily: {
        display: ['"Comodo"', 'system-ui', 'sans-serif'],
        body: ['Outfit', 'system-ui', 'sans-serif'],
        mono: ['"Geist Mono"', 'ui-monospace', 'monospace'],
        logo: ['"Comodo"', 'Outfit', 'system-ui', 'sans-serif'],
      },
      boxShadow: {
        lime: '0 0 0 1px #C7F73C, 0 18px 48px -18px rgba(199,247,60,.85)',
        magenta: '0 0 0 1px rgba(255,63,139,.5), 0 30px 80px -28px rgba(255,63,139,.65)',
      },
    },
  },
  plugins: [],
};
