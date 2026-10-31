// jest-dom adds custom jest matchers for asserting on DOM nodes.
import "@testing-library/jest-dom";

// jsdom does not provide TextEncoder/TextDecoder; proto encoding needs them.
import { TextEncoder, TextDecoder } from "util";
Object.assign(globalThis, { TextEncoder, TextDecoder });
