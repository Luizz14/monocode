import { Modal } from "../../../shared/ui/Modal";
import { BOARD_PROVIDER_LABELS, type BoardConfig } from "../model/boardTypes";

export function BoardDeleteDialog({
  config,
  onConfirm,
  onClose,
}: {
  config: BoardConfig;
  onConfirm: () => void;
  onClose: () => void;
}) {
  return (
    <Modal title={`Delete “${config.name}”?`} size="sm" onClose={onClose}>
      <div className="flex flex-col gap-4 p-4">
        <p className="text-[12px] text-content/60">
          Work items in {BOARD_PROVIDER_LABELS[config.provider]} are not
          changed.
        </p>
        <div className="flex justify-end gap-2">
          <button
            type="button"
            onClick={onClose}
            className="rounded-md px-3 py-1.5 text-[12px] hover:bg-content/8 active:scale-[0.97]"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={onConfirm}
            className="rounded-md bg-red-500 px-3 py-1.5 text-[12px] font-medium text-white hover:bg-red-500/85 active:scale-[0.97]"
          >
            Delete board
          </button>
        </div>
      </div>
    </Modal>
  );
}
