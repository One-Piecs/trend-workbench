import { createRoot } from 'react-dom/client';
import Home from '../chan-market/app/page';

// A live local page owns a lease on the local server. Unlike a polling timer,
// EventSource stays connected when the app is minimized or its tab is hidden.
let lease:EventSource;
const connect=()=>{lease=new EventSource('/session');};
connect();
window.addEventListener('pagehide',()=>lease.close());
window.addEventListener('pageshow',()=>{if(lease.readyState===EventSource.CLOSED)connect();});
createRoot(document.getElementById('root')!).render(<Home/>);
