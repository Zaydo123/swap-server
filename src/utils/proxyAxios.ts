import axios, { AxiosInstance, AxiosRequestConfig } from 'axios';
import { proxyManager, shouldUseProxy } from './proxyManager';

class ProxyAxios {
    private defaultAxios: AxiosInstance;

    constructor() {
        this.defaultAxios = axios.create();
    }

    async get(url: string, config?: AxiosRequestConfig): Promise<any> {
        return this.request('GET', url, config);
    }

    async post(url: string, data?: any, config?: AxiosRequestConfig): Promise<any> {
        return this.request('POST', url, { ...config, data });
    }

    private async request(method: string, url: string, config?: AxiosRequestConfig): Promise<any> {
        const useProxy = shouldUseProxy(url);
        
        if (!useProxy) {
            // Use default axios for non-Raydium URLs
            return this.defaultAxios.request({ method, url, ...config });
        }

        // Use proxy for Raydium API calls
        const { agent } = proxyManager.getNextProxy();
        
        const axiosConfig: AxiosRequestConfig = {
            method,
            url,
            ...config,
            httpsAgent: agent,
            httpAgent: agent,
            timeout: 10000, // 10 second timeout
        };

        try {
            const response = await axios.request(axiosConfig);
            return response;
        } catch (error: any) {
            console.warn(`[ProxyAxios] Request failed for ${url}:`, error.message);
            throw error;
        }
    }
}

export const proxyAxios = new ProxyAxios(); 