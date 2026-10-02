import './style.css';
import { DargazeApp } from './app.js';

const root = document.querySelector<HTMLElement>('#app');
if (!root) throw new Error('Dargaze app root is missing');
new DargazeApp(root);
