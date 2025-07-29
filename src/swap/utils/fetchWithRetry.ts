import fetch from 'node-fetch';
import { proxyManager, shouldUseProxy } from '../../utils/proxyManager';

export async function fetchWithRetry(
    url: string,
    options?: any,
    retries = 2, // Increased default retries for production
    timeoutMs = 10000 // Increased timeout for production
  ): Promise<any> {
    let lastError;
    let currentProxy: string | null = null;
    
    // Check if this URL should use proxy
    const useProxy = shouldUseProxy(url);
    
    for (let attempt = 0; attempt <= retries; attempt++) {
      const controller = new AbortController();
      const id = setTimeout(() => controller.abort(), timeoutMs);
      
      try {
        let fetchOptions = { ...options, signal: controller.signal };
        
        // Add proxy agent if this is a Raydium API call
        if (useProxy) {
          const { proxy, agent } = proxyManager.getNextProxy();
          currentProxy = proxy;
          fetchOptions = {
            ...fetchOptions,
            agent: agent
          };
        }
        
        const res = await fetch(url, fetchOptions);
        clearTimeout(id);
        
        // If successful, return the response
        if (res.ok || res.status < 500) {
          // Return response even for 4xx errors (let caller handle)
          return res;
        }
        
        // For 5xx errors, mark proxy as potentially problematic and retry
        if (useProxy && currentProxy && res.status >= 500) {
          console.warn(`[fetchWithRetry] Server error ${res.status} via proxy, will retry with different proxy`);
        }
        
        throw new Error(`HTTP ${res.status}: ${res.statusText}`);
        
      } catch (err) {
        lastError = err;
        clearTimeout(id);
        
        const errorMessage = err instanceof Error ? err.message : String(err);
        console.warn(`[fetchWithRetry] Attempt ${attempt + 1}/${retries + 1} failed for ${url}: ${errorMessage}`);
        
        // Mark proxy as failed if it's a connection/timeout error
        if (useProxy && currentProxy && (
          errorMessage.includes('timeout') || 
          errorMessage.includes('ECONNREFUSED') ||
          errorMessage.includes('ENOTFOUND') ||
          errorMessage.includes('ECONNRESET')
        )) {
          proxyManager.markProxyAsFailed(currentProxy);
        }
        
        // If using proxy and this wasn't the last attempt, try with a different proxy
        if (useProxy && attempt < retries) {
          console.log(`[fetchWithRetry] Retrying with different proxy...`);
        }
      }
    }
    
    // Log final failure with proxy health status
    if (useProxy) {
      const health = proxyManager.getHealthStatus();
      console.error(`[fetchWithRetry] All attempts failed for ${url}. Proxy health: ${health.available}/${health.total} available`);
    }
    
    throw lastError;
  }