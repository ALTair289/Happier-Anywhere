import sharp from "sharp";

type SharpFactory = typeof sharp;

export function loadSharp(): SharpFactory {
    return sharp;
}
