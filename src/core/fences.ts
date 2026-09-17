export const GLOBAL_FENCE = "g";

export const modelFence = (model: string): string => `m:${model}`;

export const writeFence = (model: string): string => `w:${model}`;

export const entityFence = (model: string, pk: string): string => `e:${model}:${pk}`;
