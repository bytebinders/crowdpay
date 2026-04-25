import React from 'react';
import { Routes, Route } from 'react-router-dom';
import Navbar from './components/Navbar';
import Home from './pages/Home';
import CreateCampaign from './pages/CreateCampaign';
import Campaign from './pages/Campaign';
import Login from './pages/Login';
import Register from './pages/Register';
import AdminDashboard from './pages/AdminDashboard';
import Developer from './pages/Developer';
import Dashboard from './pages/Dashboard';
import MyContributions from './pages/MyContributions';
import { AuthProvider } from './context/AuthContext';

export default function App() {
  return (
    <AuthProvider>
      <Navbar />
      <Routes>
        <Route path="/" element={<Home />} />
        <Route path="/campaigns/new" element={<CreateCampaign />} />
        <Route path="/campaigns/:id" element={<Campaign />} />
        <Route path="/login" element={<Login />} />
        <Route path="/register" element={<Register />} />
        <Route path="/admin" element={<AdminDashboard />} />
        <Route path="/developer" element={<Developer />} />
        <Route path="/dashboard" element={<Dashboard />} />
        <Route path="/my-contributions" element={<MyContributions />} />
      </Routes>
    </AuthProvider>
  );
}
