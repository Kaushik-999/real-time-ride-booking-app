/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{js,jsx}'],
  theme: {
    extend: {
      colors: {
        asphalt: '#1F2933',
        chalk: '#F3F4EF',
        rickshaw: '#F5C518',
        kerb: '#2F7A5B',
        brake: '#C8412F',
        fog: '#8A949C',
        line: '#D9DCD4',
      },
      fontFamily: { sans: ['Archivo', 'system-ui', 'sans-serif'] },
    },
  },
  plugins: [],
};
