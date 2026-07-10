import { mount } from 'svelte'
import './app.css'
import App from './App.svelte'

// PWA: required for the Android share-target save path.
if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('/sw.js').catch(() => {})
}

const app = mount(App, {
  target: document.getElementById('app')!,
})

export default app
