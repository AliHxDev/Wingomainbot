/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{js,ts,jsx,tsx}'],
  theme: {
    extend: {
      boxShadow: {
        glow: '0 0 0 1px rgba(255,255,255,.06), 0 16px 50px rgba(0,0,0,.35)'
      }
    }
  },
  plugins: []
};
