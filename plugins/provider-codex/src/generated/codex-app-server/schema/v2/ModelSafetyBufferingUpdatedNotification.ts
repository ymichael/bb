

export type ModelSafetyBufferingUpdatedNotification = { threadId: string, turnId: string, model: string, useCases: Array<string>, reasons: Array<string>, showBufferingUi: boolean, fasterModel: string | null, };
