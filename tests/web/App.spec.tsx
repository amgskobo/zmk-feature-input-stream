import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { setupZMKMocks } from "@cormoran/zmk-studio-react-hook/testing";
import App from "../../web/src/App";

jest.mock("@zmkfirmware/zmk-studio-ts-client", () => ({
  create_rpc_connection: jest.fn(),
  call_rpc: jest.fn().mockResolvedValue({}),
}));

jest.mock("@zmkfirmware/zmk-studio-ts-client/transport/serial", () => ({
  connect: jest.fn(),
}));

jest.mock("@zmkfirmware/zmk-studio-ts-client/transport/gatt", () => ({
  connect: jest.fn(),
}));

describe("App Component", () => {
  describe("Basic Rendering", () => {
    it("should render the app title and connect buttons when disconnected", () => {
      render(<App />);
      // Status bar shows the title
      expect(
        screen.getByText(/ZMK Input Stream/i, { selector: ".app-title" }),
      ).toBeInTheDocument();
      // Both connection buttons present
      expect(screen.getByText(/^Serial$/i)).toBeInTheDocument();
      expect(screen.getByText(/^BLE$/i)).toBeInTheDocument();
    });
  });

  describe("Connection Flow", () => {
    let mocks: ReturnType<typeof setupZMKMocks>;

    beforeEach(() => {
      mocks = setupZMKMocks();
    });

    it("should show connected state after clicking Serial", async () => {
      mocks.mockSuccessfulConnection({
        deviceName: "Test Keyboard",
        subsystems: ["zmk__input_stream"],
      });

      const { connect: serial_connect } =
        await import("@zmkfirmware/zmk-studio-ts-client/transport/serial");
      (serial_connect as jest.Mock).mockResolvedValue(mocks.mockTransport);

      render(<App />);

      const user = userEvent.setup();
      await user.click(screen.getByText(/^Serial$/i));

      await waitFor(
        () => {
          const found = screen.getAllByText(
            (_, el) =>
              el?.textContent?.toLowerCase().includes("test keyboard") ?? false,
          );
          expect(found.length).toBeGreaterThan(0);
        },
        { timeout: 3000 },
      );

      // Stream button and disconnect in status bar
      expect(
        screen.getByText(/Enable Stream/i, { selector: "button" }),
      ).toBeInTheDocument();
      expect(screen.getByTitle(/Disconnect/i)).toBeInTheDocument();
    });
  });
});
