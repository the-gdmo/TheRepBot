import {
    SettingsValidationRequest,
    SettingsValidationResponse,
} from "@devvit/web/shared";
import type { Context } from "hono";

const response = (c: Context, success: boolean, error?: string): Response =>
    c.json<SettingsValidationResponse>(success ? { success: true } : { success: false, error: error ?? "Invalid value." }, success ? 200 : 400);

export const handleSelectFieldHasOptionChosen = async (c: Context): Promise<Response> => {
    const request = await c.req.json<SettingsValidationRequest<string[]>>();
    if (request.value?.length !== 1) return response(c, false, "You must select an option.");
    return response(c, true);
};

export const handleNumberFieldHasValidOption = async (c: Context): Promise<Response> => {
    const request = await c.req.json<SettingsValidationRequest<number>>();
    if (typeof request.value !== "number" || Number.isNaN(request.value)) return response(c, false, "Value must be a number.");
    if (request.value < 0) return response(c, false, 'A non-negative number must be entered into the "Awards Required To Create New Posts" setting.');
    return response(c, true);
};

export const handleStringOrParagraphFieldContainsText = async (c: Context): Promise<Response> => {
    const request = await c.req.json<SettingsValidationRequest<string>>();
    if (typeof request.value !== "string") return response(c, false, "Value must be a string.");
    if (request.value.length === 0) return response(c, false, "Field cannot be empty (even if this is an irrelevant setting).");
    return response(c, true);
};

export const handleValidateTriggerWords = async (c: Context): Promise<Response> => {
    const request = await c.req.json<SettingsValidationRequest<string>>();
    const value = request.value;
    if (typeof value !== "string" || value.trim() === "") return response(c, false, "You must specify at least one trigger word.");
    const lines = value.split("\n").map((line) => line.trim());
    if (lines.some((line) => line === "")) return response(c, false, "You must specify at least one trigger word.");
    if (!lines.some((line) => /^[\x20-\x7E]+$/.test(line))) return response(c, false, "Trigger words may only contain characters that exist on a standard computer keyboard.");
    return response(c, true);
};

export const handleValidateModTriggerCommand = async (c: Context): Promise<Response> => {
    const request = await c.req.json<SettingsValidationRequest<string>>();
    if (typeof request.value !== "string" || request.value.trim() === "") return response(c, false, "You must specify a command (even if you don't intend to use it).");
    if (!/^[\x20-\x7E]+$/.test(request.value)) return response(c, false, "Command may only contain characters that exist on a standard computer keyboard.");
    return response(c, true);
};

export const handleValidateFlairTemplateId = async (c: Context): Promise<Response> => {
    const request = await c.req.json<SettingsValidationRequest<string>>();
    const value = request.value;
    if (typeof value === "string" && value.length > 0 && !/^[0-9a-f]{8}(?:-[0-9a-f]{4}){4}[0-9a-f]{8}$/i.test(value)) return response(c, false, "Invalid flair template ID.");
    return response(c, true);
};

export const handleValidateLeaderboardSize = async (c: Context): Promise<Response> => {
    const request = await c.req.json<SettingsValidationRequest<number>>();
    if (typeof request.value !== "number" || Number.isNaN(request.value)) return response(c, false, "You must enter a number.");
    if (request.value < 1 || request.value > 1000) return response(c, false, "Value should be between 1 and 1,000.");
    return response(c, true);
};

export const handleValidateLeaderboardName = async (c: Context): Promise<Response> => {
    const request = await c.req.json<SettingsValidationRequest<string>>();
    if (typeof request.value !== "string" || request.value.trim() === "") return response(c, false, "You must specify a wiki page name.");
    return response(c, true);
};

