import '@backstage/cli/asset-types';
import ReactDOM from 'react-dom/client';
import App from './App';
import '@backstage/ui/css/styles.css';
import '@fontsource-variable/schibsted-grotesk';
import '@fontsource/jetbrains-mono/400.css';
import '@fontsource/jetbrains-mono/500.css';
import './theme/global.css';

ReactDOM.createRoot(document.getElementById('root')!).render(App.createRoot());
