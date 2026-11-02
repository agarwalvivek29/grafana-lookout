import React from 'react';
import { Route, Routes } from 'react-router-dom';
import { AppRootProps } from '@grafana/data';
const ChatPage = React.lazy(() => import('../../pages/ChatPage'));

function App(_props: AppRootProps) {
  return (
    <Routes>
      {/* Full-page chat; every other path falls back to it. */}
      <Route path="*" element={<ChatPage />} />
    </Routes>
  );
}

export default App;
