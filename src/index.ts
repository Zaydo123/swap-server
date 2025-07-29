import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import { handleSwapRequest } from './swap/entrypoint';
import { proxyManager } from './utils/proxyManager';

dotenv.config();

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(cors());
app.use(express.json());

// Health check endpoint
app.get('/health', (req, res) => {
    try {
        const proxyHealth = proxyManager.getHealthStatus();
        const uptime = process.uptime();
        const memoryUsage = process.memoryUsage();
        
        res.json({
            status: 'healthy',
            timestamp: new Date().toISOString(),
            uptime: Math.floor(uptime),
            memory: {
                used: Math.round(memoryUsage.heapUsed / 1024 / 1024) + 'MB',
                total: Math.round(memoryUsage.heapTotal / 1024 / 1024) + 'MB'
            },
            proxies: {
                total: proxyHealth.total,
                available: proxyHealth.available,
                failed: proxyHealth.failed,
                health_percentage: Math.round((proxyHealth.available / proxyHealth.total) * 100)
            },
            version: process.env.npm_package_version || '1.0.0'
        });
    } catch (error) {
        res.status(500).json({
            status: 'unhealthy',
            error: error instanceof Error ? error.message : 'Unknown error',
            timestamp: new Date().toISOString()
        });
    }
});

// Main swap endpoint
app.post('/swap', handleSwapRequest);

// Basic route
app.get('/', (req, res) => {
    res.json({ 
        message: 'Swap Server API',
        version: process.env.npm_package_version || '1.0.0',
        endpoints: {
            health: 'GET /health',
            swap: 'POST /swap'
        }
    });
});

// Error handling middleware
app.use((err: any, req: express.Request, res: express.Response, next: express.NextFunction) => {
    console.error('Unhandled error:', err);
    res.status(500).json({
        success: false,
        error: 'Internal server error',
        timestamp: new Date().toISOString()
    });
});

// 404 handler
app.use((req, res) => {
    res.status(404).json({
        success: false,
        error: 'Endpoint not found',
        path: req.path,
        method: req.method
    });
});

app.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
    console.log(`Health endpoint: http://localhost:${PORT}/health`);
    console.log(`Swap endpoint: http://localhost:${PORT}/swap`);
});