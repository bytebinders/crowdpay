import React from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';

export default function Navbar() {
  const { user, logout } = useAuth();
  const navigate = useNavigate();

  function handleLogout() {
    logout();
    navigate('/');
  }

  return (
    <nav style={styles.nav}>
      <div className="container nav-inner-wrap">
        <Link to="/" style={styles.logo}>CrowdPay</Link>
        <div className="nav-links">
          {user ? (
            <>
              {user.is_admin && <Link to="/admin" style={styles.link}>Admin</Link>}
              <Link to="/campaigns/new" style={styles.link}>Start Campaign</Link>
              <Link to="/developer" style={styles.link}>Developer</Link>
              <span style={styles.name}>{user.name}</span>
              <button onClick={handleLogout} className="btn-secondary" style={{ padding: '0.4rem 0.9rem' }}>
                Logout
              </button>
            </>
          ) : (
            <>
              <Link to="/login" style={styles.link}>Log in</Link>
              <Link to="/register">
                <button className="btn-primary" style={{ padding: '0.4rem 0.9rem' }}>Sign up</button>
              </Link>
            </>
          )}
        </div>
      </div>
    </nav>
  );
}

const styles = {
  nav: { background: '#fff', borderBottom: '1px solid #e5e5e5', position: 'sticky', top: 0, zIndex: 10 },
  logo: { fontWeight: 800, fontSize: '1.15rem', color: '#7c3aed' },
  link: { color: '#444', fontWeight: 500, fontSize: '0.9rem' },
  name: { color: '#555', fontSize: '0.85rem', maxWidth: '140px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
};
