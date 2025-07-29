import { HttpsProxyAgent } from 'https-proxy-agent';

const PROXIES = [
    'p.webshare.io:80:pzkdiyqm-1:0lbtc2yxr1nz',
    'p.webshare.io:80:pzkdiyqm-2:0lbtc2yxr1nz',
    'p.webshare.io:80:pzkdiyqm-3:0lbtc2yxr1nz',
    'p.webshare.io:80:pzkdiyqm-4:0lbtc2yxr1nz',
    'p.webshare.io:80:pzkdiyqm-5:0lbtc2yxr1nz',
    'p.webshare.io:80:pzkdiyqm-6:0lbtc2yxr1nz',
    'p.webshare.io:80:pzkdiyqm-7:0lbtc2yxr1nz',
    'p.webshare.io:80:pzkdiyqm-8:0lbtc2yxr1nz',
    'p.webshare.io:80:pzkdiyqm-9:0lbtc2yxr1nz',
    'p.webshare.io:80:pzkdiyqm-10:0lbtc2yxr1nz',
    'p.webshare.io:80:pzkdiyqm-11:0lbtc2yxr1nz',
    'p.webshare.io:80:pzkdiyqm-12:0lbtc2yxr1nz',
    'p.webshare.io:80:pzkdiyqm-13:0lbtc2yxr1nz',
    'p.webshare.io:80:pzkdiyqm-14:0lbtc2yxr1nz',
    'p.webshare.io:80:pzkdiyqm-15:0lbtc2yxr1nz',
    'p.webshare.io:80:pzkdiyqm-16:0lbtc2yxr1nz',
    'p.webshare.io:80:pzkdiyqm-17:0lbtc2yxr1nz',
    'p.webshare.io:80:pzkdiyqm-18:0lbtc2yxr1nz',
    'p.webshare.io:80:pzkdiyqm-19:0lbtc2yxr1nz',
    'p.webshare.io:80:pzkdiyqm-20:0lbtc2yxr1nz',
];

// Environment-based logging
const isDevelopment = process.env.NODE_ENV === 'development';
const isDebugMode = process.env.DEBUG_PROXY === 'true';

function log(message: string, level: 'info' | 'warn' | 'error' = 'info') {
    if (isDevelopment || isDebugMode || level === 'error') {
        console[level](`[ProxyManager] ${message}`);
    }
}

class ProxyManager {
    private currentIndex = 0;
    private agents: Map<string, HttpsProxyAgent<string>> = new Map();
    private failedProxies: Set<string> = new Set();
    private lastFailureCheck = 0;
    private readonly FAILURE_RESET_INTERVAL = 5 * 60 * 1000; // 5 minutes

    constructor() {
        try {
            // Pre-create proxy agents
            PROXIES.forEach(proxy => {
                try {
                    const [host, port, username, password] = proxy.split(':');
                    if (!host || !port || !username || !password) {
                        throw new Error(`Invalid proxy format: ${proxy}`);
                    }
                    const proxyUrl = `http://${username}:${password}@${host}:${port}`;
                    this.agents.set(proxy, new HttpsProxyAgent(proxyUrl));
                } catch (error) {
                    log(`Failed to initialize proxy ${proxy}: ${error}`, 'error');
                }
            });
            
            log(`Initialized with ${this.agents.size}/${PROXIES.length} proxies`, 'info');
        } catch (error) {
            log(`Failed to initialize ProxyManager: ${error}`, 'error');
            throw error;
        }
    }

    private resetFailedProxies() {
        const now = Date.now();
        if (now - this.lastFailureCheck > this.FAILURE_RESET_INTERVAL) {
            if (this.failedProxies.size > 0) {
                log(`Resetting ${this.failedProxies.size} failed proxies`, 'info');
                this.failedProxies.clear();
            }
            this.lastFailureCheck = now;
        }
    }

    getNextProxy(): { proxy: string; agent: HttpsProxyAgent<string> } {
        this.resetFailedProxies();
        
        const availableProxies = PROXIES.filter(proxy => !this.failedProxies.has(proxy));
        
        if (availableProxies.length === 0) {
            log('All proxies failed, resetting failure list', 'warn');
            this.failedProxies.clear();
            return this.getNextProxy();
        }
        
        // Find next available proxy
        let attempts = 0;
        while (attempts < PROXIES.length) {
            const proxy = PROXIES[this.currentIndex];
            this.currentIndex = (this.currentIndex + 1) % PROXIES.length;
            
            if (!this.failedProxies.has(proxy)) {
                const agent = this.agents.get(proxy);
                if (agent) {
                    log(`Using proxy ${this.currentIndex}/${PROXIES.length}: ${proxy.split(':')[0]}:${proxy.split(':')[1]}`);
                    return { proxy, agent };
                }
            }
            attempts++;
        }
        
        // Fallback - should not reach here
        const fallbackProxy = PROXIES[0];
        const fallbackAgent = this.agents.get(fallbackProxy)!;
        log(`Fallback to first proxy: ${fallbackProxy.split(':')[0]}:${fallbackProxy.split(':')[1]}`, 'warn');
        return { proxy: fallbackProxy, agent: fallbackAgent };
    }

    getRandomProxy(): { proxy: string; agent: HttpsProxyAgent<string> } {
        this.resetFailedProxies();
        
        const availableProxies = PROXIES.filter(proxy => !this.failedProxies.has(proxy));
        
        if (availableProxies.length === 0) {
            log('All proxies failed, resetting failure list for random selection', 'warn');
            this.failedProxies.clear();
            return this.getRandomProxy();
        }
        
        const randomIndex = Math.floor(Math.random() * availableProxies.length);
        const proxy = availableProxies[randomIndex];
        const agent = this.agents.get(proxy)!;
        
        log(`Using random proxy: ${proxy.split(':')[0]}:${proxy.split(':')[1]}`);
        
        return { proxy, agent };
    }

    markProxyAsFailed(proxy: string) {
        this.failedProxies.add(proxy);
        log(`Marked proxy as failed: ${proxy.split(':')[0]}:${proxy.split(':')[1]} (${this.failedProxies.size}/${PROXIES.length} failed)`, 'warn');
    }

    getTotalProxies(): number {
        return PROXIES.length;
    }

    getAvailableProxies(): number {
        this.resetFailedProxies();
        return PROXIES.length - this.failedProxies.size;
    }

    getHealthStatus(): { total: number; available: number; failed: number } {
        this.resetFailedProxies();
        return {
            total: PROXIES.length,
            available: PROXIES.length - this.failedProxies.size,
            failed: this.failedProxies.size
        };
    }
}

export const proxyManager = new ProxyManager();

// Helper function to check if URL should use proxy
export function shouldUseProxy(url: string): boolean {
    const useProxy = url.includes('raydium.io') || url.includes('launch-mint-v1');
    if (useProxy && isDebugMode) {
        log(`Proxy required for URL: ${url}`);
    }
    return useProxy;
} 