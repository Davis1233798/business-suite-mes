# 真實 MES 報工與隔離併發展示

## 架構與資料邊界

MES Go station 提供 `POST /api/stations/mes/business`，以同一筆資料庫交易執行工單開工或報工。報工更新工單累計良品／報廢、寫入報工與稽核記錄，並以組織、端點、識別碼及請求雜湊做冪等重送保護。租戶條件必須出現在每個讀寫查詢中。

併發展示由 `POST /api/stations/mes/business-lab` 啟動。每次 run 在服務端私有資料目錄建立全新 SQLite 資料庫，初始化獨立示範組織，挑選已下達的 MES 工單，並只在該臨時資料庫補足符合 BOM 的備料台帳；然後透過相同 `business` handler 開工及並行提交報工。完成後從此臨時資料庫核對工單、報工筆數和未完數，再關閉連線並刪除該 run 目錄。不得讀寫服務的正式展示資料庫。

單一 Go 程序同時只允許一個 lab run；contenders 為 2–32。此限制是 SQLite 單資料庫並行正確性與背壓展示，不是多副本、公開容量或生產吞吐承諾。取消時伺服器等待在途呼叫、以獨立短期限核對結果，最後關閉並清除該 run 的臨時資料。併發 client 即使超時也可能已有交易提交，所以回應必須區分 unknown，不能把未知結果當作失敗或成功。

若程序遭強制終止或主機斷電，defer cleanup 不會執行，`<SUITE_DB 所在資料夾>/business-labs/business-lab-*` 可能殘留。資料位於服務專用資料目錄內，不包含正式展示空間的資料。服務不會在啟動時自動刪除這些資料夾，因為無法僅靠目錄名稱安全判斷另一個程序是否仍在使用；需先停止所有共用該資料目錄的 MES 程序，再人工檢查並只清理對應 `business-lab-*` 子目錄。此部署假設每個資料目錄只有一個 MES 程序；跨程序 run 限流尚未實作。

## 路由與權限

- `POST /api/stations/mes/business`：MES 已登入且有啟用 grant 的使用者。`start` 僅 back-office admin/operator；`report` 僅非 readonly MES grant。每個查詢使用目前 identity 的 `organization_id`。
- `POST /api/stations/mes/business-lab`：僅 MES back-office admin/operator。匿名回 401、front/readonly 回 403、其他站點回 404、錯誤 contender 回 400、run slot 已滿回 429。
- 兩個端點都只接受 JSON，同源保護沿用 Go station middleware；不接受 client 傳入 organization、使用者或檔案路徑。

## 驗收邊界

真實業務 API 測試涵蓋下達權限、租戶隔離、工單狀態／備料／BOM、目標上限、原子報工、稽核／outbox、同 key 同內容 replay、同 key 不同內容拒絕。併發測試要求多個不同 key 競逐同一工單剩餘量時只提交一次，實際工單已完成且只新增一筆報工；核對稽核與 projection event；另確認重送不重複新增業務資料。

lab 測試涵蓋臨時資料庫隔離、程序內 slot 上限、取消與錯誤時關閉/清除目錄、另一個 manager 的活動目錄不被清除、HTTP 權限／輸入界限，以及執行前後正式展示 DB 不變。瀏覽器展示結果只引用服務端回傳的持久化工單與報工核對，不把 synthetic traffic ledger 數字當作業務報工證據。此驗收不代表多程序/多節點容量，也不替代正式登入與生產授權驗收。
