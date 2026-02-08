import type { CronService } from './service.js';

let activeCronService: CronService | null = null;

export function setCronService(service: CronService | null): void {
    activeCronService = service;
}

export function getCronService(): CronService | null {
    return activeCronService;
}
