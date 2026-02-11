import { loadConfig } from './config.js';
import { startDingTalkService } from './dingtalk.js';
import { createRuntimeLogWriter } from './log/runtime.js';

const colors = {
    reset: '\x1b[0m',
    gray: '\x1b[90m',
    cyan: '\x1b[36m',
    yellow: '\x1b[33m',
    red: '\x1b[31m',
};

type RunningChannelService = {
    channel: string;
    shutdown: () => Promise<void>;
};

const SUPPORTED_CHANNELS = new Set(['dingtalk']);

function resolveConfiguredChannels(config: ReturnType<typeof loadConfig>): string[] {
    const channels: string[] = [];
    if (config.dingtalk?.enabled) {
        channels.push('dingtalk');
    }
    return channels;
}

function parseRequestedChannels(config: ReturnType<typeof loadConfig>): string[] {
    const raw = process.env.CHANNELS?.trim();
    if (!raw) {
        return resolveConfiguredChannels(config);
    }

    const requested = raw
        .split(',')
        .map((item) => item.trim().toLowerCase())
        .filter(Boolean);

    if (requested.length === 0) {
        return resolveConfiguredChannels(config);
    }

    if (requested.includes('all')) {
        return resolveConfiguredChannels(config);
    }

    return Array.from(new Set(requested));
}

export async function startServer(): Promise<void> {
    const config = loadConfig();
    const requestedChannels = parseRequestedChannels(config);
    const serverLogWriter = createRuntimeLogWriter({ prefix: 'server' });
    const dingtalkLogWriter = createRuntimeLogWriter({ prefix: 'dingtalk-server' });

    const logInfo = (message: string, ...args: unknown[]) => {
        serverLogWriter.write('INFO', message, args);
        console.log(`${colors.cyan}${message}${colors.reset}`, ...args);
    };
    const logWarn = (message: string, ...args: unknown[]) => {
        serverLogWriter.write('WARN', message, args);
        console.warn(`${colors.yellow}${message}${colors.reset}`, ...args);
    };
    const logError = (message: string, ...args: unknown[]) => {
        serverLogWriter.write('ERROR', message, args);
        console.error(`${colors.red}${message}${colors.reset}`, ...args);
    };
    const logDebug = (message: string, ...args: unknown[]) => {
        serverLogWriter.write('DEBUG', message, args);
        console.log(`${colors.gray}${message}${colors.reset}`, ...args);
    };

    try {
        logInfo(`[Server] logs -> ${serverLogWriter.filePath}`);
        logInfo(`[Server] dingtalk logs -> ${dingtalkLogWriter.filePath}`);

        if (requestedChannels.length === 0) {
            throw new Error('未找到可启动渠道。请检查 config.json 中各渠道 enabled，或设置 CHANNELS 环境变量。');
        }

        for (const channel of requestedChannels) {
            if (!SUPPORTED_CHANNELS.has(channel)) {
                throw new Error(`渠道尚未实现: ${channel}。当前支持: ${Array.from(SUPPORTED_CHANNELS).join(', ')}`);
            }
        }

        const running: RunningChannelService[] = [];

        for (const channel of requestedChannels) {
            if (channel === 'dingtalk') {
                if (!config.dingtalk?.enabled) {
                    throw new Error('请求启动 dingtalk，但 config.dingtalk.enabled=false');
                }
                const runtime = await startDingTalkService({
                    registerSignalHandlers: false,
                    exitOnShutdown: false,
                    logWriter: dingtalkLogWriter,
                });
                running.push({
                    channel: 'dingtalk',
                    shutdown: runtime.shutdown,
                });
                logInfo('[Server] channel started: dingtalk');
            }
        }

        logDebug(`[Server] active channels: ${running.map((item) => item.channel).join(', ')}`);
        logDebug('[Server] Press Ctrl+C to stop all channels.');

        let stopping = false;
        const shutdown = async (signal: string) => {
            if (stopping) return;
            stopping = true;
            logWarn(`[Server] received ${signal}, shutting down...`);

            let hasError = false;
            const services = [...running].reverse();
            for (const service of services) {
                try {
                    await service.shutdown();
                    logDebug(`[Server] channel stopped: ${service.channel}`);
                } catch (error) {
                    hasError = true;
                    logError(`[Server] channel stop failed: ${service.channel}: ${error instanceof Error ? error.message : String(error)}`);
                }
            }

            await Promise.all([
                serverLogWriter.close().catch(() => undefined),
                dingtalkLogWriter.close().catch(() => undefined),
            ]);

            process.exit(hasError ? 1 : 0);
        };

        process.on('SIGINT', () => {
            void shutdown('SIGINT');
        });
        process.on('SIGTERM', () => {
            void shutdown('SIGTERM');
        });

        await new Promise<void>(() => undefined);
    } catch (error) {
        logError(`[Server] startup failed: ${error instanceof Error ? error.message : String(error)}`);
        await Promise.all([
            serverLogWriter.close().catch(() => undefined),
            dingtalkLogWriter.close().catch(() => undefined),
        ]);
        throw error;
    }
}

startServer().catch((error) => {
    console.error(`${colors.red}[Server] fatal:${colors.reset}`, error);
    process.exit(1);
});
