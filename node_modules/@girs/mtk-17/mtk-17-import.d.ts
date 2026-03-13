import type Mtk17 from '@girs/mtk-17';

declare global {
    export interface GjsGiImports {
        Mtk: typeof Mtk17;
    }
}

export default GjsGiImports;
