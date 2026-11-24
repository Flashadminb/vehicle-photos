import { createRoot } from 'react-dom/client';
import '../shared/theme.css';
import '../field/field.css';
import './admin.css';
import { App } from './App';

createRoot(document.getElementById('root')!).render(<App />);
